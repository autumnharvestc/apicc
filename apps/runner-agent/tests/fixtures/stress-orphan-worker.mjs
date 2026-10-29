// Deliberately survives its coordinator: the test verifies OS ownership discovery, then cleans this fixture up.
setInterval(() => {}, 1000);
process.send?.({ pid: process.pid });
