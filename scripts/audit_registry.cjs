const fs = require('fs');

const content = fs.readFileSync('docs/REQUIREMENTS_REGISTRY.md', 'utf8');
const lines = content.split('\n');
const reqRegex = /^\|\s*\*\*([A-Z]{3}-\d{3})\*\*\s*\|/;
const items = [];
const stateCounts = {};
const categoryCounts = {};

for (const line of lines) {
  const m = line.match(reqRegex);
  if (m) {
    const parts = line.split('|').map(s => s.trim());
    const id = m[1];
    const prefix = id.split('-')[0];
    const state = parts[5].replace(/`/g, '');
    items.push({ id, state, line: parts[2] });
    stateCounts[state] = (stateCounts[state] || 0) + 1;
    categoryCounts[prefix] = (categoryCounts[prefix] || 0) + 1;
  }
}

console.log('Total Items:', items.length);
console.log('Category Counts:', categoryCounts);
console.log('State Breakdown:', stateCounts);
