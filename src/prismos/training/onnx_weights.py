"""Writes FunctionGemma 270M weights into onnx-community/functiongemma-270m-it-ONNX's
q4f16 graph, the file Transformers.js runs on WebGPU, in place of its own weights.

The graph stays the reference's, node for node, so the fine-tuned file loads and runs in
the browser exactly as the reference does. The weights are written as the reference
writes them, with ONNX Runtime's own quantizer: the projections as MatMulNBits, 4 bits
symmetric in blocks of 32 with fp16 scales; the embedding, which the vocabulary
projection shares, as fp16; and the norms as fp32 with Gemma's offset of one built in.

  write_weights(state_dict, "reference/model_q4f16.onnx", "out/model_q4f16.onnx")
"""
import os

import numpy as np
import onnx
from onnx import numpy_helper
from onnxruntime.capi._pybind_state import quantize_matmul_4bits

BLOCK = 32


def quantize(weight):
    """A Linear's weight, [out, in], as MatMulNBits stores it: packed [out, blocks, 16]
    and scales [out, blocks]."""
    matrix = np.ascontiguousarray(weight.astype(np.float32).T)
    rows, cols = matrix.shape
    blocks = (rows + BLOCK - 1) // BLOCK
    packed = np.zeros((cols, blocks, BLOCK // 2), dtype=np.uint8)
    scales = np.zeros((cols, blocks), dtype=np.float32)
    zero_points = np.zeros((cols, (blocks + 1) // 2), dtype=np.uint8)
    quantize_matmul_4bits(packed, matrix, scales, zero_points, BLOCK, cols, rows, True)
    return packed, scales.astype(np.float16)


def dequantize(packed, scales):
    """The inverse of quantize, for checks: [out, in] in fp32."""
    low, high = packed & 0x0F, packed >> 4
    values = np.stack([low, high], axis=-1).reshape(packed.shape[0], packed.shape[1], BLOCK).astype(np.float32) - 8
    return (values * scales.astype(np.float32)[:, :, None]).reshape(packed.shape[0], -1)


def names(layers):
    """Hugging Face name -> (ONNX name, kind) for every weight in the graph."""
    table = {"model.embed_tokens.weight": ("model.embed_tokens.weight", "embedding"),
             "model.norm.weight": (f"model.layers.{layers}.final_norm_layernorm.weight", "norm")}
    for i in range(layers):
        hf, ox = f"model.layers.{i}.", f"model.layers.{i}."
        for norm in ["input_layernorm", "post_attention_layernorm", "pre_feedforward_layernorm", "post_feedforward_layernorm"]:
            table[hf + norm + ".weight"] = (ox + norm + ".weight", "norm")
        for norm in ["q_norm", "k_norm"]:
            table[hf + f"self_attn.{norm}.weight"] = (ox + f"attn.{norm}.layernorm.weight", "norm")
        for projection in ["q_proj", "k_proj", "v_proj", "o_proj"]:
            table[hf + f"self_attn.{projection}.weight"] = (ox + f"attn.{projection}.MatMul.weight", "linear")
        for projection in ["gate_proj", "up_proj", "down_proj"]:
            table[hf + f"mlp.{projection}.weight"] = (ox + f"mlp.{projection}.MatMul.weight", "linear")
    return table


def write_weights(state, reference, out, layers=18):
    """state: Hugging Face name -> numpy array. Writes out and out + "_data"."""
    graph = onnx.load(reference)
    initializers = {tensor.name: tensor for tensor in graph.graph.initializer}
    written = set()

    def put(name, array):
        old = initializers[name]
        if list(old.dims) != list(array.shape) or old.data_type != onnx.helper.np_dtype_to_tensor_dtype(array.dtype):
            raise ValueError(f"{name}: the graph has {list(old.dims)} type {old.data_type}, the weights {list(array.shape)} {array.dtype}")
        old.CopyFrom(numpy_helper.from_array(array, name))
        written.add(name)

    for hf, (name, kind) in names(layers).items():
        weight = np.asarray(state[hf], dtype=np.float32)
        if kind == "embedding":
            put(name, weight.astype(np.float16))
        elif kind == "norm":
            put(name, weight + 1)
        else:
            packed, scales = quantize(weight)
            put(name + "_Q4", packed)
            put(name + "_scales", scales)
    weights = {tensor.name for tensor in graph.graph.initializer if tensor.name.startswith("model.")}
    if weights - written:
        raise ValueError(f"weights in the graph that nothing wrote: {sorted(weights - written)[:5]}")
    location = os.path.basename(out) + "_data"
    # onnx appends to an existing data file, so a stale one would grow and break the graph.
    if os.path.exists(os.path.join(os.path.dirname(out), location)):
        os.remove(os.path.join(os.path.dirname(out), location))
    onnx.save_model(graph, out, save_as_external_data=True, all_tensors_to_one_file=True, location=location)


def read_weights(reference, layers=18):
    """The graph's weights as a Hugging Face state dict in fp32, for checks."""
    graph = onnx.load(reference)
    initializers = {tensor.name: tensor for tensor in graph.graph.initializer}
    state = {}
    for hf, (name, kind) in names(layers).items():
        if kind == "linear":
            state[hf] = dequantize(numpy_helper.to_array(initializers[name + "_Q4"]), numpy_helper.to_array(initializers[name + "_scales"]))
        else:
            value = numpy_helper.to_array(initializers[name]).astype(np.float32)
            state[hf] = value - 1 if kind == "norm" else value
    return state
