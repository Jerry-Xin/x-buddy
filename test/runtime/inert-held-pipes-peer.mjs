// SPDX-License-Identifier: Apache-2.0
// Owned inert peer and descendant. No SDK, model, network or shared home.
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { writeFileSync } from 'node:fs';
const [mode, stop, eof] = process.argv.slice(2);
const program = `
const fs=require('node:fs');const [mode,stop,eof]=process.argv.slice(1);let announced=false;
const poll=setInterval(()=>{
 if(fs.existsSync(stop)){clearInterval(poll);process.exit(23);}
 if(!announced&&fs.existsSync(eof)){announced=true;setTimeout(()=>process.stdout.write(JSON.stringify({method:'owned-late-drain',params:{owned:true}})+'\\n'),200);}
},15);
if(mode==='finite')setTimeout(()=>process.exit(23),6500);
`;
const helper = spawn(process.execPath, ['-e', program, mode, stop, eof], {
  env: { PATH: '/usr/bin:/bin' }, stdio: ['ignore', 'inherit', 'inherit'],
});
process.stdout.write(JSON.stringify({ method: 'owned-descendant', params: { pid: helper.pid } }) + '\n');
const input = createInterface({ input: process.stdin });
input.on('line', line => {
  const request = JSON.parse(line);
  if (request.id !== undefined) process.stdout.write(JSON.stringify({ id: request.id, result: {} }) + '\n');
});
input.on('close', () => { writeFileSync(eof, 'owned EOF marker'); process.exit(7); });
