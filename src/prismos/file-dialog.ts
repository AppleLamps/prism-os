import {button, el} from './dom.ts'

export function fileDialog(title: string, options: {value?: string, folders?: {id: string, path: string}[], choices?: string[], message?: string} = {}): Promise<{choice: string, value: string} | null> {
  return new Promise(resolve => {
    const dialog = el('dialog', 'cabinet-dialog')
    dialog.dataset['prismLayer'] = ''
    const form = el('form')
    const heading = el('h2', '', title)
    heading.id = 'cabinet-dialog-title'
    dialog.setAttribute('aria-labelledby', heading.id)
    form.append(heading)
    if (options.message !== undefined) form.append(el('p', '', options.message))
    const field = options.folders !== undefined ? el('select') : el('input')
    field.setAttribute('aria-label', options.folders !== undefined ? 'Destination folder' : title)
    if (field instanceof HTMLSelectElement) for (const folder of options.folders ?? []) {
      const option = el('option', '', folder.path); option.value = folder.id; field.append(option)
    }
    field.value = options.value ?? ''
    if (options.value !== undefined || options.folders) form.append(field)
    const actions = el('div', 'cabinet-actions')
    let finished = false
    const finish = (answer: {choice: string, value: string} | null) => {
      if (finished) return
      finished = true; dialog.close(); dialog.remove(); resolve(answer)
    }
    for (const choice of options.choices ?? ['OK']) {
      const item = button('', choice, choice)
      item.addEventListener('click', () => finish({choice, value: field.value}))
      actions.append(item)
    }
    const cancel = button('', 'Cancel', 'Cancel')
    cancel.addEventListener('click', () => finish(null))
    actions.append(cancel); form.append(actions); dialog.append(form)
    form.addEventListener('submit', event => { event.preventDefault(); finish({choice: options.choices?.[0] ?? 'OK', value: field.value}) })
    dialog.addEventListener('cancel', event => { event.preventDefault(); finish(null) })
    document.body.append(dialog); dialog.showModal(); field.focus()
    if (field instanceof HTMLInputElement) field.select()
  })
}

export function downloadFile(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob)
  const link = el('a'); link.href = url; link.download = name; link.click()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}
