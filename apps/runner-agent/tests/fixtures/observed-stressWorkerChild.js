// Native ownership fixture only: a real child remains alive until its real coordinator closes it.
process.on('message',()=>{});setInterval(()=>{},1000);
