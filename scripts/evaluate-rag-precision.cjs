async function main() {
  const loginRes = await fetch('http://127.0.0.1:8787/api/v1/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'operator@local.dev', password: 'test-password-1234' }),
  });
  const cookies = loginRes.headers.getSetCookie().map(c => c.split(';')[0]).join('; ');
  const loginData = await loginRes.json();
  const csrf = loginData.csrfToken;
  const project = loginData.projects[0].id;

  async function ask(q) {
    const res = await fetch('http://127.0.0.1:8787/api/v1/rag/query', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Cookie': cookies,
        'x-csrf-token': csrf,
        'x-project-id': project,
      },
      body: JSON.stringify({ question: q }),
    });
    const d = await res.json();
    console.log(`Query: "${q}"`);
    console.log(`  Status: ${res.status}`);
    console.log(`  Outcome: ${d.outcome}, Grounded: ${d.grounded}, Sources count: ${d.sources?.length}`);
    if (d.sources?.length) {
      console.log(`  Distances: ${d.sources.map(s => s.distance?.toFixed(4)).join(', ')}`);
    }
    console.log(`  Answer preview: ${(d.answer || '').slice(0, 100)}...`);
  }

  console.log('--- TEST 1: Direct related query ---');
  await ask('What capabilities does NirnayAI have?');

  console.log('\n--- TEST 2: Specific related fact ---');
  await ask('Which offline speech synthesis engine is supported?');

  console.log('\n--- TEST 3: Completely unrelated query ---');
  await ask('What is the capital city of Australia and its population?');

  console.log('\n--- TEST 4: Another completely unrelated query ---');
  await ask('Who won the 1994 FIFA World Cup tournament?');
}

main().catch(console.error);
