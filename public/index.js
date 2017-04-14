
fetch('/current').then(res => {
  const version = res.headers.get('x-content-version')

  res.blob().then(blob => {
    const img = new Image
    img.src = URL.createObjectURL(blob)
    document.body.appendChild(img)

  })

  const eventsource = new EventSource('/changes?from=' + version)
  eventsource.onmessage = e => console.log('event', e)
})



