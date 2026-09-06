type Item = {
  accent: string
  index: number
  name: string
  value: number
}

const items: readonly Item[] = [
  {
    accent: '#0c7f84',
    index: 0,
    name: 'Aster',
    value: 10,
  },
  {
    accent: '#a15c18',
    index: 1,
    name: 'Banyan',
    value: 20,
  },
  {
    accent: '#7545a0',
    index: 2,
    name: 'Cobalt',
    value: 30,
  },
]

function mustQuery<T extends Element>(selector: string): T {
  const element = document.querySelector<T>(selector)
  if (element === null) throw new Error(`Missing element: ${selector}`)
  return element
}

const querySlider = mustQuery<HTMLInputElement>('#query-slider')
const betaSlider = mustQuery<HTMLInputElement>('#beta-slider')
const queryReadout = mustQuery<HTMLOutputElement>('#query-readout')
const betaReadout = mustQuery<HTMLOutputElement>('#beta-readout')
const queryVector = mustQuery<HTMLElement>('#query-vector')
const presetRow = mustQuery<HTMLElement>('#preset-row')
const itemTrack = mustQuery<HTMLElement>('#item-track')
const onehotFormula = mustQuery<HTMLElement>('#onehot-formula')
const hardFormula = mustQuery<HTMLElement>('#hard-formula')
const softFormula = mustQuery<HTMLElement>('#soft-formula')

function scoreFor(queryIndex: number, itemIndex: number) {
  return 2 * queryIndex * itemIndex - itemIndex * itemIndex
}

function keyFor(itemIndex: number): [number, number] {
  return [2 * itemIndex, -itemIndex * itemIndex]
}

function formatNumber(value: number) {
  return value.toFixed(2).replace(/\\.00$/, '')
}

function winnerIndexFor(scores: readonly number[]) {
  let winnerIndex = 0
  let winnerScore = scores[0]
  if (winnerScore === undefined) throw new Error('Expected at least one score')
  for (let index = 1; index < scores.length; index++) {
    const score = scores[index]
    if (score === undefined) throw new Error(`Missing score at ${index}`)
    if (score > winnerScore) {
      winnerIndex = index
      winnerScore = score
    }
  }
  return winnerIndex
}

function softmax(scores: readonly number[], beta: number) {
  const maxScore = Math.max(...scores)
  const weights = scores.map(score => Math.exp((score - maxScore) * beta))
  const total = weights.reduce((sum, weight) => sum + weight, 0)
  return weights.map(weight => weight / total)
}

function setStyleNumber(element: HTMLElement, name: string, value: number) {
  element.style.setProperty(name, `${Math.max(0, Math.min(100, value))}%`)
}

function createItems() {
  for (const item of items) {
    const [keyX, keyY] = keyFor(item.index)
    const article = document.createElement('article')
    article.className = 'item-card'
    article.dataset['index'] = String(item.index)
    article.style.setProperty('--accent', item.accent)
    article.innerHTML = `
      <div class="item-photo">
        <div class="item-name">
          <strong>${item.name}</strong>
          <span>value ${item.value}</span>
        </div>
      </div>
      <div class="item-body">
        <div class="stat-row"><span>index</span><code>${item.index}</code></div>
        <div class="stat-row"><span>key</span><code>(${keyX}, ${keyY})</code></div>
        <div class="stat-row"><span>score</span><code data-role="score"></code></div>
        <div class="meter score" aria-hidden="true"></div>
        <div class="stat-row"><span>one-hot</span><code data-role="onehot"></code></div>
        <div class="stat-row"><span>soft</span><code data-role="soft"></code></div>
        <div class="meter soft" aria-hidden="true"></div>
      </div>
    `
    itemTrack.append(article)

    const button = document.createElement('button')
    button.type = 'button'
    button.textContent = `${item.index}: ${item.name}`
    button.addEventListener('click', () => {
      querySlider.value = String(item.index)
      update()
    })
    presetRow.append(button)
  }
}

function updatePresetButtons(queryIndex: number) {
  const rounded = Math.round(queryIndex)
  for (const button of presetRow.querySelectorAll('button')) {
    const indexText = button.textContent.slice(0, 1)
    button.setAttribute('aria-pressed', indexText === String(rounded) ? 'true' : 'false')
  }
}

function update() {
  const queryIndex = Number(querySlider.value)
  const beta = Number(betaSlider.value)
  const scores = items.map(item => scoreFor(queryIndex, item.index))
  const winnerIndex = winnerIndexFor(scores)
  const winner = items[winnerIndex]
  if (winner === undefined) throw new Error(`Missing winner at ${winnerIndex}`)
  const onehot = items.map(item => item.index === winner.index ? 1 : 0)
  const weights = softmax(scores, beta)
  const onehotValue = items.reduce((sum, item, index) => {
    const bit = onehot[index]
    if (bit === undefined) throw new Error(`Missing one-hot bit at ${index}`)
    return sum + bit * item.value
  }, 0)
  const softValue = items.reduce((sum, item, index) => {
    const weight = weights[index]
    if (weight === undefined) throw new Error(`Missing soft weight at ${index}`)
    return sum + weight * item.value
  }, 0)

  queryReadout.value = formatNumber(queryIndex)
  betaReadout.value = beta.toFixed(1)
  queryVector.textContent = `(${formatNumber(queryIndex)}, 1)`
  updatePresetButtons(queryIndex)

  for (const card of itemTrack.querySelectorAll<HTMLElement>('.item-card')) {
    const itemIndex = Number(card.dataset['index'])
    const score = scores[itemIndex]
    const bit = onehot[itemIndex]
    const weight = weights[itemIndex]
    if (score === undefined || bit === undefined || weight === undefined) {
      throw new Error(`Missing display values for item ${itemIndex}`)
    }
    card.classList.toggle('is-winner', itemIndex === winner.index)
    const scoreNode = card.querySelector<HTMLElement>('[data-role="score"]')
    const onehotNode = card.querySelector<HTMLElement>('[data-role="onehot"]')
    const softNode = card.querySelector<HTMLElement>('[data-role="soft"]')
    if (scoreNode === null || onehotNode === null || softNode === null) {
      throw new Error(`Missing item nodes for ${itemIndex}`)
    }
    scoreNode.textContent = formatNumber(score)
    onehotNode.textContent = String(bit)
    softNode.textContent = weight.toFixed(3)
    setStyleNumber(card, '--score-fill', ((score + 4) / 8) * 100)
    setStyleNumber(card, '--soft-fill', weight * 100)
  }

  onehotFormula.textContent = `${onehot.join(', ')} x [${items.map(item => item.value).join(', ')}] = ${onehotValue}`
  hardFormula.textContent = `values[${winner.index}] = ${winner.value} (${winner.name})`
  softFormula.textContent = `${weights.map(weight => weight.toFixed(2)).join(', ')} x [${items.map(item => item.value).join(', ')}] = ${softValue.toFixed(2)}`
}

createItems()
querySlider.addEventListener('input', update)
betaSlider.addEventListener('input', update)
update()
