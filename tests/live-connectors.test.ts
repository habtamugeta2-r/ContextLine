import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { Redis } from 'ioredis';
import { PgVectorConnector,RedisConnector } from '../packages/worker/src/index.js';
test('live Redis delete/invalidate/verify and TTL preservation',{skip:!process.env.REDIS_URL},async()=>{
  const client=new Redis(process.env.REDIS_URL!,{lazyConnect:true,maxRetriesPerRequest:1,enableOfflineQueue:false,connectTimeout:5000});await client.connect();
  const context={tenantId:'live-test'},key=`live-test:contextline:${randomUUID()}`,connector=new RedisConnector(client);
  try{
    await client.set(key,'synthetic','EX',120);await connector.invalidate(key,context);assert.equal(await connector.verify(key,context,'invalidated'),true);const ttl=await client.ttl(key);assert.ok(ttl>0&&ttl<=120);assert.equal(await connector.verify(key,context,'deleted'),false);await connector.delete(key,context);assert.equal(await connector.verify(key,context,'deleted'),true);await connector.delete(key,context);
  }finally{await client.del(key);await client.quit();}
});
test('live pgvector row deletion and idempotent verification',{skip:!process.env.CONTEXTLINE_TEST_DATABASE_URL||process.env.CONTEXTLINE_TEST_PGVECTOR!=='1'},async()=>{
  const pool=new pg.Pool({connectionString:process.env.CONTEXTLINE_TEST_DATABASE_URL!,max:2});const id=randomUUID(),tenant='live-vector-test';
  try{
    await pool.query('CREATE EXTENSION IF NOT EXISTS vector');await pool.query('CREATE TABLE IF NOT EXISTS contextline_vector_test (id text PRIMARY KEY,tenant_id text NOT NULL,embedding vector(3))');
    await pool.query("INSERT INTO contextline_vector_test VALUES ($1,$2,'[1,2,3]')",[id,tenant]);const connector=new PgVectorConnector(pool,{table:'contextline_vector_test'});
    assert.equal((await connector.healthCheck()).healthy,true);await connector.delete(id,{tenantId:tenant});assert.equal(await connector.verify(id,{tenantId:tenant},'deleted'),true);await connector.delete(id,{tenantId:tenant});
  }finally{await pool.query('DELETE FROM contextline_vector_test WHERE id=$1',[id]).catch(()=>undefined);await pool.end();}
});
