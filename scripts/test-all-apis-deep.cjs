const http = require('http');

function request({ path, method = 'GET', headers = {} }, body = null) {
  return new Promise((resolve, reject) => {
    const postData = body ? (typeof body === 'string' ? body : JSON.stringify(body)) : null;
    const finalHeaders = { ...headers };
    if (postData && !finalHeaders['Content-Type']) {
      finalHeaders['Content-Type'] = 'application/json';
      finalHeaders['Content-Length'] = Buffer.byteLength(postData);
    }

    const req = http.request({
      hostname: '127.0.0.1',
      port: 8787,
      path,
      method,
      headers: finalHeaders
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(data); } catch {}
        resolve({ status: res.statusCode, headers: res.headers, data, json });
      });
    });

    req.on('error', reject);
    if (postData) req.write(postData);
    req.end();
  });
}

function parseCookies(cookieHeaders) {
  if (!cookieHeaders) return '';
  const cookies = Array.isArray(cookieHeaders) ? cookieHeaders : [cookieHeaders];
  return cookies.map(c => c.split(';')[0]).join('; ');
}

async function main() {
  console.log("================================================================");
  console.log("   DEEP API PROBE: TESTING ALL 9 SUBSYSTEM ENDPOINTS            ");
  console.log("================================================================\n");

  // Login
  const loginRes = await request({ path: '/api/v1/auth/login', method: 'POST' }, {
    email: 'operator@local.dev',
    password: 'test-password-1234'
  });
  const cookies = parseCookies(loginRes.headers['set-cookie']);
  const projectId = loginRes.json.projects[0].id;
  const csrfToken = loginRes.json.csrfToken;
  console.log(`✓ Authenticated: operator@local.dev (Project: ${projectId})\n`);

  const authHeaders = {
    'Cookie': cookies,
    'x-project-id': projectId,
    'x-csrf-token': csrfToken
  };

  // 1. CHAT
  console.log("1. Testing Chat (POST /api/v1/chat)...");
  const chatRes = await request({ path: '/api/v1/chat', method: 'POST', headers: authHeaders }, {
    messages: [{ role: 'user', content: 'What is 2 + 2?' }]
  });
  console.log(`   Status: ${chatRes.status}`);
  console.log(`   Response snippet: ${chatRes.data.slice(0, 100).replace(/\n/g, ' ')}...`);

  // 2. TASKS
  console.log("\n2. Testing Tasks (POST /api/v1/agent/tasks)...");
  const taskRes = await request({ path: '/api/v1/agent/tasks', method: 'POST', headers: authHeaders }, {
    taskType: 'echo_chat',
    input: { message: 'Echo test' }
  });
  console.log(`   Create Status: ${taskRes.status}`);
  console.log(`   Created Task ID: ${taskRes.json?.task?.id}`);

  console.log("   Listing Tasks (GET /api/v1/agent/tasks)...");
  const listTasksRes = await request({ path: '/api/v1/agent/tasks', headers: authHeaders });
  console.log(`   List Status: ${listTasksRes.status}, Count: ${listTasksRes.json?.tasks?.length}`);

  // 3. CODING AGENT
  console.log("\n3. Testing Coding Agent (POST /api/v1/agent/tasks fix_failing_test)...");
  const codingTaskRes = await request({ path: '/api/v1/agent/tasks', method: 'POST', headers: authHeaders }, {
    taskType: 'fix_failing_test',
    input: { testDir: 'coding-demo', testFile: 'math.test.js' }
  });
  console.log(`   Create Status: ${codingTaskRes.status}`);
  console.log(`   Coding Task ID: ${codingTaskRes.json?.task?.id}`);

  // 4. IMAGES
  console.log("\n4. Testing Images (GET /api/v1/media/providers & POST /api/v1/images)...");
  const providersRes = await request({ path: '/api/v1/media/providers', headers: authHeaders });
  console.log(`   Providers:`, JSON.stringify(providersRes.json?.providers));
  const imgRes = await request({ path: '/api/v1/images', method: 'POST', headers: authHeaders }, {
    prompt: 'A sunset on the beach'
  });
  console.log(`   Image Create Status: ${imgRes.status}`);
  console.log(`   Image Error/Message: ${imgRes.json?.error?.message || imgRes.data}`);

  // 5. VIDEOS
  console.log("\n5. Testing Videos (POST /api/v1/videos)...");
  const vidRes = await request({ path: '/api/v1/videos', method: 'POST', headers: authHeaders }, {
    prompt: 'A drone shot over the ocean',
    targetDurationSeconds: 8,
    sceneClipSeconds: 4
  });
  console.log(`   Video Create Status: ${vidRes.status}`);
  console.log(`   Video Error/Message: ${vidRes.json?.error?.message || vidRes.data}`);

  // 6. AUDIO
  console.log("\n6. Testing Audio (POST /api/v1/audio)...");
  const audioRes = await request({ path: '/api/v1/audio', method: 'POST', headers: authHeaders }, {
    text: 'Hello from NirnayAI audio probe.',
    speed: 1
  });
  console.log(`   Audio Create Status: ${audioRes.status}`);
  console.log(`   Audio Response:`, JSON.stringify(audioRes.json || audioRes.data));

  // 7. FILES
  console.log("\n7. Testing Files (GET /api/v1/files)...");
  const filesRes = await request({ path: '/api/v1/files', headers: authHeaders });
  console.log(`   Files List Status: ${filesRes.status}, Documents: ${filesRes.json?.documents?.length}`);

  // 8. ASK
  console.log("\n8. Testing Ask (POST /api/v1/rag/query)...");
  const askRes = await request({ path: '/api/v1/rag/query', method: 'POST', headers: authHeaders }, {
    question: 'What is in the knowledge base?'
  });
  console.log(`   Ask Status: ${askRes.status}`);
  console.log(`   Ask Response:`, JSON.stringify(askRes.json || askRes.data));

  // 9. ADMIN
  console.log("\n9. Testing Admin (GET /api/v1/admin/health)...");
  const adminRes = await request({ path: '/api/v1/admin/health', headers: authHeaders });
  console.log(`   Admin Health Status: ${adminRes.status}`);
  console.log(`   Health Checks:`, JSON.stringify(adminRes.json?.checks));
}

main().catch(console.error);
