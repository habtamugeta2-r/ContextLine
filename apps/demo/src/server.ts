import { DemoApp } from './app.js';
const app=new DemoApp();
let stopping=false;
async function stop(): Promise<void> {if(stopping)return;stopping=true;await app.stop();process.exit(0);}
process.on('SIGTERM',()=>{void stop();});process.on('SIGINT',()=>{void stop();});
try {
  await app.start();
  console.log(`ContextLine demo listening on 0.0.0.0:${app.port}`);
  console.log('Synthetic data only. No LLM calls. Selector identities are NOT authentication.');
  console.log('Documentation: docs/quickstart.md | Stop with Ctrl+C.');
} catch {
  console.error('Demo startup failed. Ensure dev dependencies are installed, the build is current, and the demo database port is free.');
  await app.stop().catch(()=>undefined);process.exitCode=1;
}
