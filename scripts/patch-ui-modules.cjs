const fs = require('fs');
const path = require('path');

// 1. Patch Tasks Page
const tasksPath = path.resolve('frontend/app/tasks/page.tsx');
let tasksCode = fs.readFileSync(tasksPath, 'utf8');

if (!tasksCode.includes('Echo Chat Preset')) {
  tasksCode = tasksCode.replace(
    'const [fieldValues, setFieldValues] = useState<Record<string, string>>({});',
    `const [fieldValues, setFieldValues] = useState<Record<string, string>>({
    message: "Hello from Universal AI Agent task runner!",
  });`
  );

  const tasksPresets = `      {/* Quick Action Presets */}
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 16 }}>
        <button
          type="button"
          className="btn btn-secondary"
          style={{ fontSize: "12px", padding: "4px 10px" }}
          onClick={() => {
            setTaskType("echo_chat");
            setFieldValues({ message: "Hello from Universal AI Agent task runner!" });
          }}
        >
          ⚡ Echo Chat Preset
        </button>
        <button
          type="button"
          className="btn btn-secondary"
          style={{ fontSize: "12px", padding: "4px 10px" }}
          onClick={() => {
            setTaskType("autonomous");
            setFieldValues({ goal: "Analyze workspace and summarize status" });
          }}
        >
          🤖 Autonomous Agent Preset
        </button>
        <button
          type="button"
          className="btn btn-secondary"
          style={{ fontSize: "12px", padding: "4px 10px" }}
          onClick={() => {
            setTaskType("fix_failing_test");
            setFieldValues({ testDir: "coding-demo", testFile: "math.test.js" });
          }}
        >
          🔧 Coding Fix Preset
        </button>
        <button
          type="button"
          className="btn btn-secondary"
          style={{ fontSize: "12px", padding: "4px 10px" }}
          onClick={() => {
            setTaskType("answer_from_documents");
            setFieldValues({ question: "What capabilities does NirnayAI have?" });
          }}
        >
          📚 Document RAG Preset
        </button>
      </div>\n\n      <form className="card" onSubmit={handleCreate}>`;

  tasksCode = tasksCode.replace('<form className="card" onSubmit={handleCreate}>', tasksPresets);
  fs.writeFileSync(tasksPath, tasksCode, 'utf8');
  console.log('✓ Patched TasksPage');
} else {
  console.log('TasksPage already patched');
}

// 2. Patch Audio Page
const audioPath = path.resolve('frontend/app/audio/page.tsx');
let audioCode = fs.readFileSync(audioPath, 'utf8');

if (!audioCode.includes('Quick Voice Presets')) {
  audioCode = audioCode.replace(
    'const [text, setText] = useState("");',
    'const [text, setText] = useState("Hello from NirnayAI Windows SAPI speech synthesis.");'
  );

  const audioPresets = `      {/* Quick Voice Presets */}
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 16 }}>
        <button
          type="button"
          className="btn btn-secondary"
          style={{ fontSize: "12px", padding: "4px 10px" }}
          onClick={() => setText("Hello from NirnayAI Windows SAPI speech synthesis.")}
        >
          🗣️ Sample: NirnayAI Introduction
        </button>
        <button
          type="button"
          className="btn btn-secondary"
          style={{ fontSize: "12px", padding: "4px 10px" }}
          onClick={() => setText("Universal AI Agent autonomous platform is online and operational.")}
        >
          🚀 Sample: System Status
        </button>
        <button
          type="button"
          className="btn btn-secondary"
          style={{ fontSize: "12px", padding: "4px 10px" }}
          onClick={() => setText("Speech synthesis completed successfully on Windows with audio playback.")}
        >
          🔊 Sample: Speech Test
        </button>
      </div>\n\n      <form className="card" onSubmit={handleSubmit}>`;

  audioCode = audioCode.replace('<form className="card" onSubmit={handleSubmit}>', audioPresets);
  fs.writeFileSync(audioPath, audioCode, 'utf8');
  console.log('✓ Patched AudioPage');
} else {
  console.log('AudioPage already patched');
}

// 3. Patch Files Page
const filesPath = path.resolve('frontend/app/files/page.tsx');
let filesCode = fs.readFileSync(filesPath, 'utf8');

if (!filesCode.includes('Seed Sample Document')) {
  const seedHelper = `  async function handleSeedKnowledge() {
    setUploading(true);
    setError(null);
    try {
      const sampleText = "NirnayAI Universal AI Agent Platform\\n\\n" +
        "NirnayAI is a fully independent, self-hosted multimodal autonomous AI platform.\\n" +
        "Capabilities include:\\n" +
        "1. Real Chat reasoning using local Qwen 2.5 and compatible models.\\n" +
        "2. Deterministic and autonomous task engine with human approval gates.\\n" +
        "3. Coding agent with test-driven fix loop and rollback safety.\\n" +
        "4. Offline speech synthesis via Windows SAPI and Piper TTS.\\n" +
        "5. Secure Document RAG with vector search and verifiable citations.\\n";
      const blob = new Blob([sampleText], { type: "text/plain" });
      const file = new File([blob], "nirnay-knowledge-base.txt", { type: "text/plain" });
      await uploadFile(file);
      refresh();
    } catch (e) {
      setError(String(e));
    } finally {
      setUploading(false);
    }
  }\n\n  async function handleUpload(e: React.FormEvent) {`;

  filesCode = filesCode.replace('async function handleUpload(e: React.FormEvent) {', seedHelper);

  const seedButton = `        <div style={{ marginBottom: 16 }}>
          <button
            type="button"
            className="btn btn-secondary"
            disabled={uploading}
            onClick={handleSeedKnowledge}
            style={{ fontSize: "13px", padding: "6px 14px", fontWeight: 600 }}
          >
            {uploading ? "Ingesting Knowledge Base…" : "📄 Seed Sample Document (nirnay-knowledge-base.txt)"}
          </button>
        </div>\n\n      <form className="card" onSubmit={handleUpload}>`;

  filesCode = filesCode.replace('<form className="card" onSubmit={handleUpload}>', seedButton);
  fs.writeFileSync(filesPath, filesCode, 'utf8');
  console.log('✓ Patched FilesPage');
} else {
  console.log('FilesPage already patched');
}

// 4. Patch Ask Page
const askPath = path.resolve('frontend/app/ask/page.tsx');
let askCode = fs.readFileSync(askPath, 'utf8');

if (!askCode.includes('Quick RAG Queries')) {
  const askPresets = `      {/* Quick RAG Queries */}
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", margin: "12px 0" }}>
        <button
          type="button"
          className="btn btn-secondary"
          style={{ fontSize: "12px", padding: "4px 10px" }}
          onClick={() => {
            setQuestion("What capabilities does NirnayAI Universal AI Agent have?");
          }}
        >
          ❓ What capabilities does NirnayAI have?
        </button>
        <button
          type="button"
          className="btn btn-secondary"
          style={{ fontSize: "12px", padding: "4px 10px" }}
          onClick={() => {
            setQuestion("How does the agent handle rollback safety?");
          }}
        >
          ❓ How does rollback safety work?
        </button>
        <button
          type="button"
          className="btn btn-secondary"
          style={{ fontSize: "12px", padding: "4px 10px" }}
          onClick={() => {
            setQuestion("What speech synthesis capabilities are available?");
          }}
        >
          ❓ What speech synthesis is available?
        </button>
      </div>\n\n      <form onSubmit={handleAsk}`;

  askCode = askCode.replace('<form onSubmit={handleAsk}', askPresets);
  fs.writeFileSync(askPath, askCode, 'utf8');
  console.log('✓ Patched AskPage');
} else {
  console.log('AskPage already patched');
}

// 5. Patch Images Page Status Banner
const imagesPath = path.resolve('frontend/app/images/page.tsx');
let imagesCode = fs.readFileSync(imagesPath, 'utf8');

if (!imagesCode.includes('Provider Configuration Notice')) {
  const imageBanner = `      {/* Provider Configuration Notice */}
      {unavailable && (
        <div
          style={{
            padding: "12px 16px",
            borderRadius: "6px",
            background: "color-mix(in srgb, #2563eb 8%, transparent)",
            border: "1px solid #2563eb",
            marginBottom: 16,
            fontSize: "13px",
            lineHeight: 1.5,
          }}
        >
          <strong>ℹ️ Image Generation Provider Status:</strong> Image synthesis is not configured on this deployment.
          To activate real local diffusion, configure <code>IMAGE_SD_CLI_PATH</code> or <code>IMAGE_BASE_URL</code> (docs/MEDIA.md).
          The application safely blocks execution when no model is attached to prevent silent mock generation.
        </div>
      )}\n\n      <form className="card" onSubmit={handleSubmit}>`;

  imagesCode = imagesCode.replace('<form className="card" onSubmit={handleSubmit}>', imageBanner);
  fs.writeFileSync(imagesPath, imagesCode, 'utf8');
  console.log('✓ Patched ImagesPage');
} else {
  console.log('ImagesPage already patched');
}

// 6. Patch Videos Page Status Banner
const videosPath = path.resolve('frontend/app/videos/page.tsx');
let videosCode = fs.readFileSync(videosPath, 'utf8');

if (!videosCode.includes('Video Provider Configuration Notice')) {
  const videoBanner = `      {/* Video Provider Configuration Notice */}
      {(!videoProvider || !videoProvider.available) && (
        <div
          style={{
            padding: "12px 16px",
            borderRadius: "6px",
            background: "color-mix(in srgb, #2563eb 8%, transparent)",
            border: "1px solid #2563eb",
            marginBottom: 16,
            fontSize: "13px",
            lineHeight: 1.5,
          }}
        >
          <strong>ℹ️ Video Generation Provider Status:</strong> Long-form video synthesis requires ffmpeg and a configured video renderer (<code>VIDEO_PROVIDER</code>, docs/MEDIA.md).
          When unconfigured, requests are safely gated to guarantee transparency.
        </div>
      )}\n\n      <form className="card" onSubmit={handleSubmit}>`;

  videosCode = videosCode.replace('<form className="card" onSubmit={handleSubmit}>', videoBanner);
  fs.writeFileSync(videosPath, videosCode, 'utf8');
  console.log('✓ Patched VideosPage');
} else {
  console.log('VideosPage already patched');
}
