"""Makes a decoder ONNX graph compute logits for the last position only.

ONNX Runtime GenAI's builder writes graphs whose `logits` output covers every input
position. For FunctionGemma's 262,144-word vocabulary and Prism OS's 1,863-token prompt,
that is about 1 GB of fp16 logits, cast to 2 GB of fp32, on every first step, while
generation only reads the last row. This inserts a Slice before the vocabulary
projection (`/lm_head/MatMul`), so `logits` has one position and every later step is
unchanged (it had one position already).

  python last_token_logits.py <model.onnx>   (rewrites the file in place)
"""
import sys

import onnx
from onnx import TensorProto, helper


def last_token_logits(path: str) -> None:
    model = onnx.load(path, load_external_data=False)
    graph = model.graph
    producers = {output: node for node in graph.node for output in node.output}
    matmul = next(node for node in graph.node if node.name == "/lm_head/MatMul")
    hidden = matmul.input[0]
    if hidden in producers and producers[hidden].op_type == "Slice":
        print("already slices the last position", flush=True)
        return
    constants = [
        helper.make_tensor("/lm_head/last/starts", TensorProto.INT64, [1], [-1]),
        helper.make_tensor("/lm_head/last/ends", TensorProto.INT64, [1], [2**62]),
        helper.make_tensor("/lm_head/last/axes", TensorProto.INT64, [1], [1]),
    ]
    graph.initializer.extend(constants)
    sliced = "/lm_head/last/output_0"
    slice_node = helper.make_node("Slice", [hidden, *(c.name for c in constants)], [sliced], name="/lm_head/last/Slice")
    index = list(graph.node).index(matmul)
    graph.node.insert(index, slice_node)
    matmul.input[0] = sliced
    for output in graph.output:
        if output.name == "logits":
            dim = output.type.tensor_type.shape.dim[1]
            dim.Clear()
            dim.dim_value = 1
    # Weights stay in the external data file that the graph already points to.
    onnx.save_model(model, path)
    print(f"{path}: logits now cover the last position only", flush=True)


if __name__ == "__main__":
    last_token_logits(sys.argv[1])
