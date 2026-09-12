import { ANSWER } from "./math.js";
if (ANSWER !== 42) { console.error("FAIL: expected 42, got " + ANSWER); process.exit(1); }
console.log("PASS");
