/**
 * List variables in .om files - compare T+0 (analysis) vs T+1 (forecast)
 */

import { OmFileReader } from '@openmeteo/file-reader';

class HttpBackend {
  constructor(url) { this.url = url; }
  async getBytes(offset, size) {
    const res = await fetch(this.url, {
      headers: { Range: `bytes=${offset}-${offset + size - 1}` }
    });
    return new Uint8Array(await res.arrayBuffer());
  }
  async count() {
    const res = await fetch(this.url, { method: 'HEAD' });
    return parseInt(res.headers.get('content-length'));
  }
}

async function listVars(url) {
  console.log('File:', url.split('/').slice(-2).join('/'));
  const backend = new HttpBackend(url);
  const reader = await OmFileReader.create(backend);
  console.log('Variables:');
  for (let i = 0; i < reader.numberOfChildren(); i++) {
    const child = await reader.getChild(i);
    console.log(' -', child.getName());
  }
  console.log('');
}

// T+0 (analysis) vs T+1 (forecast) for same run
await listVars('https://openmeteo.s3.amazonaws.com/data_spatial/ecmwf_ifs/2025/12/08/1200Z/2025-12-08T1200.om');
await listVars('https://openmeteo.s3.amazonaws.com/data_spatial/ecmwf_ifs/2025/12/08/1200Z/2025-12-08T1300.om');
