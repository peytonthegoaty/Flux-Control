// Fake "game" load for benchmarking: busy CPU workers plus a moving full-motion test video on the main screen.
//   node tools/load.js <seconds> <busyWorkers>
const { spawn } = require('child_process');
const secs = +process.argv[2] || 20, workers = +process.argv[3] || 6, source = process.argv[4] || 'testsrc2';
const kids = [];
for (let i = 0; i < workers; i++) kids.push(spawn(process.execPath, ['-e', 'for(;;){Math.sqrt(Math.random())}'], { stdio: 'ignore' }));
kids.push(spawn('ffplay', ['-loglevel', 'quiet', '-f', 'lavfi', '-i', source === 'mandelbrot' ? 'mandelbrot=size=1280x720:rate=60:end_scale=0.001' : 'testsrc2=size=1280x720:rate=60', '-x', '1280', '-y', '720', '-left', '100', '-top', '100', '-alwaysontop', '-noborder'], { stdio: 'ignore' }));
setTimeout(() => { kids.forEach((k) => k.kill()); process.exit(0); }, secs * 1000);
