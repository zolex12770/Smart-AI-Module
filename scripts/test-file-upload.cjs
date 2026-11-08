const http = require('http');

async function testUpload() {
  console.log("=== Testing File Upload and Document Ingestion ===");
  const loginRes = await new Promise((res, rej) => {
    const req = http.request({ hostname: '127.0.0.1', port: 8787, path: '/api/v1/auth/login', method: 'POST', headers: { 'Content-Type': 'application/json' } }, (r) => {
      let d = ''; r.on('data', c => d += c); r.on('end', () => res({ headers: r.headers, json: JSON.parse(d) }));
    });
    req.write(JSON.stringify({ email: 'operator@local.dev', password: 'test-password-1234' })); req.end();
  });
  const cookieHeaders = loginRes.headers['set-cookie'];
  const cookie = (Array.isArray(cookieHeaders) ? cookieHeaders : [cookieHeaders]).map(c => c.split(';')[0]).join('; ');
  const projectId = loginRes.json.projects[0].id;
  const csrf = loginRes.json.csrfToken;

  const boundary = '----WebKitFormBoundary7MA4YWxkTrZu0gW';
  const fileContent = 'NirnayAI is an advanced autonomous AI platform with native multi-model orchestration, local coding sandbox, and Windows speech synthesis.';
  const body = Buffer.concat([
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="knowledge.txt"\r\nContent-Type: text/plain\r\n\r\n`),
    Buffer.from(fileContent),
    Buffer.from(`\r\n--${boundary}--\r\n`)
  ]);

  const uploadRes = await new Promise((res) => {
    const req = http.request({
      hostname: '127.0.0.1',
      port: 8787,
      path: '/api/v1/files/upload',
      method: 'POST',
      headers: {
        'Cookie': cookie,
        'x-project-id': projectId,
        'x-csrf-token': csrf,
        'Content-Type': `multipart/form-data; boundary=${boundary}`,
        'Content-Length': body.length
      }
    }, (r) => {
      let d = ''; r.on('data', c => d += c); r.on('end', () => res({ status: r.statusCode, data: d }));
    });
    req.write(body); req.end();
  });
  console.log('Upload status:', uploadRes.status, uploadRes.data);

  const docId = JSON.parse(uploadRes.data).document.id;
  console.log('Document ID:', docId);

  // Poll document status
  for (let i = 0; i < 15; i++) {
    await new Promise(r => setTimeout(r, 1000));
    const docRes = await new Promise((res) => {
      http.get({ hostname: '127.0.0.1', port: 8787, path: `/api/v1/files/${docId}`, headers: { 'Cookie': cookie, 'x-project-id': projectId } }, (r) => {
        let d = ''; r.on('data', c => d += c); r.on('end', () => res(JSON.parse(d)));
      });
    });
    console.log(`Poll #${i+1} status=${docRes.document.status}, chunks=${docRes.document.chunkCount}, error=${docRes.document.errorMessage}`);
    if (docRes.document.status === 'ready' || docRes.document.status === 'failed') break;
  }

  // Now test RAG query on this document!
  console.log("\n=== Testing RAG Query on Ingested Document ===");
  const ragRes = await new Promise((res) => {
    const data = JSON.stringify({ question: "What capabilities does NirnayAI have?" });
    const req = http.request({
      hostname: '127.0.0.1',
      port: 8787,
      path: '/api/v1/rag/query',
      method: 'POST',
      headers: {
        'Cookie': cookie,
        'x-project-id': projectId,
        'x-csrf-token': csrf,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(data)
      }
    }, (r) => {
      let d = ''; r.on('data', c => d += c); r.on('end', () => res({ status: r.statusCode, json: JSON.parse(d) }));
    });
    req.write(data); req.end();
  });
  console.log('RAG Query Status:', ragRes.status);
  console.log('RAG Query Answer:', JSON.stringify(ragRes.json, null, 2));
}

testUpload().catch(console.error);
