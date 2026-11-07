import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, writeFile, unlink, chmod, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { initdb, pg_ctl } from '@embedded-postgres/linux-x64';
const exec=promisify(execFile);

/** Linux-x64 development cluster. Never use these credentials for a deployed service. */
export class LocalPostgres {
  private readonly dir: string;
  private started=false;
  private socketDir: string | null = null;
  constructor(private readonly options: {databaseDir:string;port:number;password:string}) {this.dir=resolve(options.databaseDir);}
  async initialise(): Promise<void> {
    await mkdir(this.dir,{recursive:true,mode:0o700});await chmod(this.dir,0o700);
    const passwordFile=resolve(this.dir,'..',`.contextline-init-${randomUUID()}`);
    await writeFile(passwordFile,this.options.password+'\n',{mode:0o600});
    try {await exec(initdb,['--pgdata='+this.dir,'--auth=scram-sha-256','--username=postgres','--pwfile='+passwordFile,'--locale=C','--encoding=UTF8'],{timeout:30000,env:{...process.env,LC_ALL:'C'},maxBuffer:1048576});}
    finally {await unlink(passwordFile).catch(()=>undefined);}
  }
  async start(): Promise<void> {
    // PostgreSQL's Unix socket path has a ~107-byte limit. Deep CI checkout paths plus
    // UUID data directories can exceed it, so keep the socket in a short temp directory.
    this.socketDir=await mkdtemp(join(tmpdir(),'contextline-'));
    try {
      await exec(pg_ctl,['-D',this.dir,'-l',resolve(this.dir,'server.log'),'-o',`-p ${this.options.port} -h 127.0.0.1 -k ${this.socketDir}`,'-w','-t','30','start'],{timeout:35000,env:{...process.env,LC_ALL:'C'},maxBuffer:1048576});
      this.started=true;
    } catch (error) {
      await rm(this.socketDir,{recursive:true,force:true}).catch(()=>undefined);
      this.socketDir=null;
      throw error;
    }
  }
  async stop(): Promise<void> {
    if(!this.started)return;
    try {await exec(pg_ctl,['-D',this.dir,'-m','fast','-w','-t','30','stop'],{timeout:35000,env:{...process.env,LC_ALL:'C'},maxBuffer:1048576});}
    finally {
      this.started=false;
      if(this.socketDir)await rm(this.socketDir,{recursive:true,force:true}).catch(()=>undefined);
      this.socketDir=null;
    }
  }
}
