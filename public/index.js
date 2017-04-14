
// We actually need 2 canvases, 1 for the view and 1 for the content.
const imgCanvas = document.createElement('canvas')
imgCanvas.width = 1000; imgCanvas.height = 1000
const imgctx = imgCanvas.getContext('2d')

// Actual canvas drawn to the screen.
const canvas = document.getElementsByTagName('canvas')[0]
const ctx = canvas.getContext('2d')
ctx.imageSmoothingEnabled = false


const palette = [
  [255, 255, 255], // white
  [228, 228, 228], // light grey
  [136, 136, 136], // grey
  [34, 34, 34], //black

  [131, 0, 124], // dark Purple
  [207, 109, 223], // light purple
  [255,165,207], // pink
  [234, 0, 9], // red

  [233, 216, 59], // yellow
  [233, 147, 39], // orange
  
  [0, 213, 220], // cyan
  [0, 133, 195], // medium blue
  [0, 18, 227], // dark blue

  [149, 224, 89], // light green
  [0, 191, 49], // green

  [163, 105, 170], // brown
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
    this.scrollX += dx / this.size
    this.scrollY += dy / this.size

    this.clampFrame()

    draw()
  }

  clampFrame() {
    const imgwidth = 1000 * this.size
    const visX = this.width / this.size
    const visY = this.height / this.size

    if (imgwidth > this.width)
      this.scrollX = clamp(this.scrollX, 0, 1000 - visX)
    else
      this.scrollX = clamp(this.scrollX, 1000 - visX, 0)

    if (imgwidth > this.height)
      this.scrollY = clamp(this.scrollY, 0, 1000 - visY)
    else
      this.scrollY = clamp(this.scrollY, 1000 - visY, 0)
  }

  resizeTo(width, height) {
    this.width = width
    this.height = height

    canvas.width = width
    canvas.height = height
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
    if (tx == null) return {px:null, py:null}
    return {
      px: tx * this.size - Math.floor(this.scrollX * this.size),
      py: ty * this.size - Math.floor(this.scrollY * this.size)
    }
  }
}

// Current color tool.
let brush = 0

let needsDraw = false
const view = new View(0, 0)
view.resizeTo(window.innerWidth, window.innerHeight)
// Zoom out to the whole image at first.
view.fit(1000, 1000, 0, 0)

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

  const {tx, ty} = mouse
  if (tx < 0 || tx >= 1000 || ty < 0 || ty >= 1000) return

  fetch(`/edit?x=${tx}&y=${ty}&c=${brush}`, {method: 'POST'})
  draw()
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

function draw() {
  if (needsDraw) return
  needsDraw = true
  requestAnimationFrame(() => {
    ctx.clearRect(0, 0, canvas.width, canvas.height)

    ctx.save()
    ctx.imageSmoothingEnabled = false
    ctx.scale(view.size, view.size)
    //console.log(view.scrollX, view.scrollY, view.size)
    //const {px, py} = view.worldToScreen(0, 0)
    ctx.translate(-view.scrollX, -view.scrollY)
    ctx.drawImage(imgCanvas, 0, 0)
    ctx.restore()
    //ctx.drawImage(imgCanvas, 0, 0, 10000, 10000)
  
    needsDraw = false
  })
}

// Lets just start with hotpink everywhere until we load.
imgctx.fillStyle = 'hotpink'
imgctx.fillRect(0, 0, 1000, 1000)
draw()


fetch('/current').then(res => {
  const version = res.headers.get('x-content-version')

  res.blob().then(blob => {
    const img = new Image
    img.src = URL.createObjectURL(blob)

    img.onload = () => {
      imgctx.drawImage(img, 0, 0)
      draw()

      const eventsource = new EventSource('/changes?from=' + version)

      const imagedata = imgctx.createImageData(1, 1)
      const d = imagedata.data

      eventsource.onmessage = msg => {
        const [x, y, coloridx] = JSON.parse(msg.data)
        console.log('set', x, y, coloridx)
        const color = palette[coloridx]
        d[0] = color[0]
        d[1] = color[1]
        d[2] = color[2]
        d[3] = 255
        imgctx.putImageData(imagedata, x, y)

        draw()
      }
    }
  })

})



