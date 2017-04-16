
// We actually need 2 canvases, 1 for the view and 1 for the content.
const imgCanvas = document.createElement('canvas')
imgCanvas.width = 1000; imgCanvas.height = 1000
const imgctx = imgCanvas.getContext('2d')

// Actual canvas drawn to the screen.
const canvas = document.getElementsByTagName('canvas')[0]
let ctx

let isConnected = false

const elems = {}

;['toolbar', 'pantool', 'position', 'connected', 'zoomin', 'zoomout'].forEach(name => elems[name] = document.getElementById(name))

const toolbarelems = [elems.pantool]

// zoomin, zoomout, ..?
const motion = new Set

const palette = [
  [255, 255, 255], // white
  [228, 228, 228], // light grey
  [136, 136, 136], // grey
  [34, 34, 34], //black

  [255,167,209], // pink
  [229, 0, 9], // red
  [229, 149, 0], // orange

  [160, 106, 66], // brown

  [229, 217, 0], // yellow
  [148, 224, 68], // light green
  [2, 190, 1], // green
  [0, 211, 221], // cyan

  [0, 131, 199], // medium blue
  [0, 0, 234], // dark blue
  [207, 110, 228], // light purple
  [130, 0, 128], // dark Purple
]


const clamp = (x, min, max) => Math.max(Math.min(x, max), min);

// Stolen from josephg/boilerplate to give me a pannable canvas
class View {
  constructor(width, height, options) {
    this.width = width
    this.height = height
    this.reset(options)
  }

  reset(options = {}) {
    this.zoomLevel = options.initialZoom || 1
    this.zoomBy(0) // set this.size.

    // In tile coordinates.
    this.scrollX = options.initialX || 0
    this.scrollY = options.initialY || 0
    draw()
  }

  fit(w, h, offx, offy) {
    // Put a 1 tile border in.
    //offx -= 1; offy -= 1
    //w += 2; h += 2

    this.scrollX = offx
    this.scrollY = offy
    const sizeW = this.width / w, sizeH = this.height / h
    let tileSize

    //debugger;
    if (sizeW > sizeH) {
      tileSize = clamp(sizeH, 1, 100)
      this.scrollX -= (this.width/tileSize - w)/2
    } else {
      tileSize = clamp(sizeW, 1, 100)
      this.scrollY -= (this.height/tileSize - h)/2
    }
    this.zoomLevel = tileSize
    this.zoomBy(0)
  }

  zoomBy(diff, center) { // Center is {x, y}
    //console.log(diff, center)
    const oldsize = this.size
    this.zoomLevel += diff
    this.zoomLevel = clamp(this.zoomLevel, 1, 100)

    this.size = this.zoomLevel

    // Recenter
    if (center != null) {
      this.scrollX += center.x / oldsize - center.x / this.size
      this.scrollY += center.y / oldsize - center.y / this.size
    }

    this.clampFrame()

    //console.log(scrollX, scrollY, this.size)
    draw()
  }

  snap(center) {
    const fl = Math.floor(this.size)
    // const AMT = 0.05
    if (this.size != fl) {
      const oldsize = this.size
      this.size = fl//(oldsize - fl < AMT) ? fl : oldsize - AMT

      if (center != null) {
        this.scrollX += center.x / oldsize - center.x / this.size
        this.scrollY += center.y / oldsize - center.y / this.size
      }
      return true
    } else return false
  }

  scrollBy(dx, dy) {
    if (isNaN(dx)) throw Error('dx NaN')
    this.scrollX += dx / this.size
    this.scrollY += dy / this.size

    this.clampFrame()

    draw()
  }

  clampFrame() {
    // Clamp the visible area so the middle of the screen always has content.
    const imgwidth = 1000 * this.size
    const visX = this.width / this.size
    const visY = this.height / this.size

    if (imgwidth > this.width)
      this.scrollX = clamp(this.scrollX, -visX/2, 1000 - visX/2)
    else
      this.scrollX = clamp(this.scrollX, 500 - visX, 500)

    if (imgwidth > this.height)
      this.scrollY = clamp(this.scrollY, -visX/2, 1000 - visY/2)
    else
      this.scrollY = clamp(this.scrollY, 500 - visY, 500)
  }

  resizeTo(width, height) {
    this.width = width
    this.height = height

    canvas.width = width * devicePixelRatio
    canvas.height = height * devicePixelRatio
    ctx = canvas.getContext('2d')
    ctx.scale(window.devicePixelRatio, window.devicePixelRatio)

    // TODO: Scale based on devicePixelRatio.
    draw()
  }

  // **** Utility methods

  // given pixel x,y returns tile x,y
  screenToWorld(px, py) {
    if (px == null) return {tx:null, ty:null}
    // first, the top-left pixel of the screen is at |_ scroll * size _| px from origin
    px += Math.floor(this.scrollX * this.size)
    py += Math.floor(this.scrollY * this.size)
    // now we can simply divide and floor to find the tile
    const tx = Math.floor(px / this.size)
    const ty = Math.floor(py / this.size)
    return {tx, ty}
  }

  worldToScreen(tx, ty) {
    return {
      px: tx * this.size - Math.floor(this.scrollX * this.size),
      py: ty * this.size - Math.floor(this.scrollY * this.size)
    }
  }
}

// Current color tool.
let brush = 0
let mode = null
const setMode = (newMode) => {
  mode = newMode
  if (mode === 'pan') {
    canvas.style.cursor = '-webkit-grab'
    elems.pantool.className = 'enabled'
  }
  else {
    canvas.style.cursor = 'crosshair'
    elems.pantool.className = ''
  }
}

setMode('pan') // 'pan', 'paint'.

const setEnabledElem = enabledelem => {
  toolbarelems.forEach(e => e.className = (e === enabledelem) ? 'enabled' : '')
}

elems.pantool.onclick = () => {
  setMode('pan')
  setEnabledElem(elems.pantool)
}

{
  // Add brush tools.
  for (let i = 0; i < 16; i++) {
    const elem = document.createElement('div')
    const c = palette[i]
    elem.style.backgroundColor = `rgb(${c[0]}, ${c[1]}, ${c[2]})`
    elem.style.height = '30px'
    ;(i => elem.onclick = () => {
      setMode('paint')
      brush = i
      setEnabledElem(elem)
    })(i)

    toolbarelems.push(elem)
    elems.toolbar.appendChild(elem)
  }
}

['zoomin', 'zoomout'].forEach(b => {
  const elem = elems[b]
  elem.onmousedown = e => {
    motion.add(b)
    draw()
  }
  elem.onmouseup = elem.onmouseleave = e => {
    motion.delete(b)
  }
})

let needsDraw = false
const view = new View(0, 0, {initialX: -10, initialY: -10, initialZoom: 10})
view.resizeTo(window.innerWidth, window.innerHeight)
// Zoom out to the whole image at first.
//view.fit(1000, 1000, 0, 0)

window.onresize = () => view.resizeTo(window.innerWidth, window.innerHeight)

const mouse = {}
const updateMousePos = (e) => {
  mouse.from = {tx: mouse.tx, ty: mouse.ty};

  if (e) {
    const oldX = mouse.x;
    const oldY = mouse.y;
    mouse.x = clamp(e.offsetX, 0, canvas.offsetWidth - 1);
    mouse.y = clamp(e.offsetY, 0, canvas.offsetHeight - 1);
    mouse.dx = mouse.x - oldX
    mouse.dy = mouse.y - oldY
  }

  const {tx, ty} = view.screenToWorld(mouse.x, mouse.y);

  if (tx !== mouse.tx || ty !== mouse.ty) {
    mouse.tx = tx;
    mouse.ty = ty;
    return true;
  } else {
    return false;
  }
}

canvas.onmousedown = e => {
  updateMousePos(e)

  if (mode === 'paint') {
    const {tx, ty} = mouse
    if (tx < 0 || tx >= 1000 || ty < 0 || ty >= 1000) return

    const oldColor = imgctx.getImageData(tx, ty, 1, 1).data
    const color = palette[brush]

    if (oldColor[0] !== color[0] || oldColor[1] !== color[1] || oldColor[2] !== color[2]) {
      const imagedata = imgctx.createImageData(1, 1)
      const d = imagedata.data

      d[0] = color[0]
      d[1] = color[1]
      d[2] = color[2]
      d[3] = 150 // not with full opacity.
      imgctx.putImageData(imagedata, tx, ty)

      // Put this in a timeout to test the speculative drawing.
      fetch(`edit?x=${tx}&y=${ty}&c=${brush}`, {method: 'POST'}).then(res => {
        // This isn't perfect - it has a race condition if someone else edits the
        // pixel while we're waiting for our edit to go through. But it'll do for
        // now.
        if (res.status !== 200) {
          d[0] = oldColor[0]
          d[1] = oldColor[1]
          d[2] = oldColor[2]
          d[3] = 255 // not with full opacity.

          imgctx.putImageData(imagedata, tx, ty)
        }
      })

      draw()
    }
  } else if (mode === 'pan') {
    canvas.style.cursor = '-webkit-grabbing'
  }
  e.preventDefault();
}


canvas.onmousemove = e => {
  if (updateMousePos(e)) {

    elems.position.textContent = `(${mouse.tx}, ${mouse.ty})`

    if (mode === 'paint') draw() // So we can draw the edit hover.
  }

  // e.buttons is undefined in safari. e.which is always 1 in firefox. :(
  const b = e.buttons == null ? e.which : e.buttons
  if (b === 1 && mouse.dx && mode === 'pan') {
    view.scrollBy(-mouse.dx, -mouse.dy)
    draw()
  }
}

canvas.onmouseup = e => {
  if (mode === 'pan') canvas.style.cursor = '-webkit-grab'
}

window.onkeydown = e => {
  //console.log(e.keyCode)
  if (e.keyCode === 32 && mode === 'paint') setMode('pan') // space
}

window.onkeyup = e => {
  if (e.keyCode === 32 && mode === 'pan') setMode('paint') // space
}


window.onwheel = e => {
  updateMousePos(e)
  if (e.shiftKey || e.ctrlKey) {
    view.zoomBy(-(e.deltaY + e.deltaX) / 40, mouse);
  } else {
    view.scrollBy(e.deltaX, e.deltaY);
  }
  const d = view.screenToWorld(mouse.x, mouse.y);
  mouse.tx = d.tx; mouse.ty = d.ty;

  e.preventDefault();
}

let lastScale = 1
window.addEventListener('gesturestart', e => {
  e.preventDefault()
  lastScale = 1
}, true)
window.addEventListener('gesturechange', e => {
  view.zoomBy(view.size * (e.scale / lastScale - 1), mouse)
  lastScale = e.scale
  e.preventDefault()
}, true)
window.addEventListener('gesturechange', e => {
  e.preventDefault()
}, true)

const isInScreen = (tx, ty) => (
  tx >= 0 && tx < 1000 && ty >= 0 && ty < 1000
)

function draw() {
  if (needsDraw) return
  needsDraw = true
  requestAnimationFrame(() => {
    needsDraw = false

    if (motion.has('zoomin')) {
      view.zoomBy(0.2, {x:view.width/2, y:view.height/2})
      draw()
    } else if (motion.has('zoomout')) {
      view.zoomBy(-0.2, {x:view.width/2, y:view.height/2})
      draw()
    }

    ctx.fillStyle = '#eee'
    ctx.fillRect(0, 0, canvas.width, canvas.height)

    ctx.save()
    ctx.imageSmoothingEnabled = false
    ctx.scale(view.size, view.size)
    //console.log(view.scrollX, view.scrollY, view.size)
    //const {px, py} = view.worldToScreen(0, 0)
    ctx.translate(-view.scrollX, -view.scrollY)
    ctx.drawImage(imgCanvas, 0, 0)

    ctx.font = '15px monospace'
    ctx.fillStyle = '#333'
    ;['Rules:', 'No swastikas', "Buy me dinner before you show me your junk"]
    .forEach((str, i) => { ctx.fillText(str, 0, 1000 + (i+1) * 15) })

    if (mode === 'paint' && isInScreen(mouse.tx, mouse.ty)) {
      const c = palette[brush]
      ctx.fillStyle = `rgba(${c[0]}, ${c[1]}, ${c[2]}, 0.5)`
      ctx.fillRect(mouse.tx + 0.1, mouse.ty + 0.1, 0.8, 0.8)
    }
    ctx.restore()
    //ctx.drawImage(imgCanvas, 0, 0, 10000, 10000)
  
  })
}

imgctx.fillStyle = 'grey'
imgctx.fillRect(0, 0, 1000, 1000)
draw()

const setConnected = (newStatus) => {
  isConnected = newStatus

  if (isConnected) {
    elems.connected.className = 'yes'
    elems.connected.textContent = 'OK'
  } else {
    elems.connected.className = 'no'
    elems.connected.textContent = 'NOT CONNECTED'
  }
}

const imagedata = imgctx.createImageData(1, 1)
const _d = imagedata.data
function rawSet(x, y, c, alpha = 255) {
  const color = palette[c]
  _d[0] = color[0]
  _d[1] = color[1]
  _d[2] = color[2]
  _d[3] = alpha
  imgctx.putImageData(imagedata, x, y)
  draw()
}

const decodeEdit = (buffer, offset) => { // returns x, y, color.
  const xx = buffer[offset]
  const yx = buffer[offset + 1]
  const cy = buffer[offset + 2]

  const x = xx | ((yx & 0x3) << 8)
  const y = (yx >>> 2) | ((cy & 0xf) << 6)
  const c = cy >> 4

  return [x, y, c]
}

function connectWS(version) {
  const origin = 'ws' + location.origin.slice(4)
  const ws = new WebSocket(`${origin}/sp/ws?from=${version}`)
  ws.binaryType = 'arraybuffer'

  ws.onopen = () => {
    console.log('connection open')
    setConnected(true)
  }

  ws.onmessage = (msg) => {
    //console.log('got message', msg.data, msg)
    if (typeof msg.data === 'string') {
      if (msg.data === 'reload') {
        setConnected(false)
        ws.close()
        setTimeout(() => connect(true), 2000)
      } else if (msg.data === 'refresh') {
        location.reload()
      } else console.log(msg.data)
    } else {
      // Ok, its an ArrayBuffer. Process all data.
      const vb = new Uint32Array(msg.data.slice(0, 4))
      version = vb[0]
      window._version = version

      const ab = new Uint8Array(msg.data)
      for (let i = 4; i < ab.length; i+=3) {
        const [x, y, c] = decodeEdit(ab, i)
        //console.log('decode', ab[i], ab[i+1], ab[i+2], x, y, c)
        rawSet(x, y, c)
      }
    }
  }

  ws.onclose = () => {
    setConnected(false)
    setTimeout(() => connectWS(version), 3000)
  }

  ws.onerror = err => {
    setConnected(false)
    console.error('ws error', err)

    // And close and reconnect.
  }
}


function connect(skipcache) {
  fetch('current', {cache: skipcache ? 'no-cache' : 'default'}).then(res => {
    const version = res.headers.get('x-content-version')
    window._version = version

    res.blob().then(blob => {
      const img = new Image
      img.src = URL.createObjectURL(blob)

      img.onload = () => {
        imgctx.drawImage(img, 0, 0)
        draw()

        connectWS(version)
      }
    })
  })
}

connect()

