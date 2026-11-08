/**
 * Nirnay.AI Shared Conversational Intent & Satisfaction Representation Engine
 * 
 * Provides robust natural-language intent extraction, multilingual (English, Hindi, Hinglish, Indian English)
 * prompt normalization, multi-turn reference resolution, constraint preservation, and specialized
 * module adapters (Chat, Tasks, Coding, Images, Videos, Audio, Ask/RAG).
 */

export type LinguisticModality =
  | "english"
  | "hindi_devanagari"
  | "hinglish"
  | "indian_english"
  | "unknown";

export type CoreIntent =
  | "IMAGE_GENERATION"
  | "CODING_TASK"
  | "VIDEO_GENERATION"
  | "AUDIO_SYNTHESIS"
  | "TASK_EXECUTION"
  | "CHAT_REASONING"
  | "DOCUMENT_QA"
  | "MEMORY_OPERATION"
  | "ADMIN_OPERATION";

export type TargetModule =
  | "chat"
  | "tasks"
  | "coding"
  | "images"
  | "videos"
  | "audio"
  | "files"
  | "ask"
  | "memory"
  | "admin";

export interface IntentEntities {
  userName?: string;
  userCity?: string;
  userRole?: string;
  codeFiles?: string[];
  testFiles?: string[];
  technologies?: string[];
  visualSubjects?: string[];
  visualStyles?: string[];
  searchTerms?: string[];
  numbers?: number[];
}

export interface IntentState {
  sessionId: string;
  timestamp: number;
  originalPrompt: string;
  detectedLanguage: LinguisticModality;
  targetModule: TargetModule;
  intent: CoreIntent;
  subIntent: string;
  isRevision: boolean;
  requiredActions: string[];
  explicitConstraints: string[];
  negativeConstraints: string[];
  preservedConstraints: string[];
  outputFormat: string;
  contextReferences: string[];
  userPreferences: Record<string, unknown>;
  relevantPriorArtifacts: string[];
  assumptions: string[];
  unresolvedAmbiguity: string[];
  completionCriteria: string[];
  expectedOutput: string;
  enhancedPrompt: string;
  basePrompt: string;
  entities: IntentEntities;
}

export interface IntentProcessOptions {
  forcedIntent?: CoreIntent;
  targetModule?: TargetModule;
  userPreferences?: Record<string, unknown>;
  priorArtifacts?: string[];
}

export interface ChatIntentAdapter {
  topic: string;
  userProfile: { name?: string; city?: string; role?: string };
  reasoningStyle: "concise" | "in_depth" | "socratic" | "code_first";
  languageModality: LinguisticModality;
  isCodeRequest: boolean;
  isMathCalculation: boolean;
  requiresMemoryRecall: boolean;
  constraints: string[];
}

export interface TaskIntentStep {
  stepIndex: number;
  title: string;
  toolRequired: string;
  description: string;
  dependencies: number[];
  acceptanceCriteria: string;
}

export interface TaskIntentAdapter {
  workflowGoal: string;
  steps: TaskIntentStep[];
  targetModule: TargetModule;
  estimatedComplexity: "low" | "medium" | "high";
}

export interface CodingIntentAdapter {
  testFile?: string;
  targetFile?: string;
  language: "typescript" | "javascript" | "python" | "cpp" | "unknown";
  actionType: "fix_test" | "write_feature" | "refactor" | "code_review" | "explain";
  testCommand: string;
  testArgs: string[];
  cwd: string;
  errorSymptom?: string;
  expectedBehavior?: string;
}

export interface ImageIntentAdapter {
  subject: string;
  positivePrompt: string;
  negativePrompt: string;
  lighting: string;
  style: string;
  aspectRatio: string;
  width: number;
  height: number;
  isRevision: boolean;
  preservations: string[];
}

export interface RagIntentAdapter {
  rawQuery: string;
  canonicalEnglishTerms: string[];
  extractedEntities: string[];
  targetDocTypes?: string[];
  requiresGroundedCitations: boolean;
  refusalOnEmpty: boolean;
}

export interface MediaIntentAdapter {
  mediaType: "audio" | "video";
  narrationScript: string;
  targetDurationSeconds: number;
  voiceGender: "neutral" | "male" | "female";
  scenes?: Array<{ sceneIndex: number; visualPrompt: string; narrationChunk: string }>;
}

export class ConversationalIntentEngine {
  private readonly sessionContext = new Map<string, IntentState>();

  /**
   * Detects the linguistic modality: English, Devanagari Hindi, Hinglish, or Indian English.
   */
  detectLanguage(text: string): LinguisticModality {
    if (!text || typeof text !== "string") return "unknown";

    // 1. Devanagari Unicode Block (\u0900-\u097F)
    const devanagariRegex = /[\u0900-\u097F]/;
    if (devanagariRegex.test(text)) {
      return "hindi_devanagari";
    }

    // 2. Hinglish markers (Romanized Hindi words)
    const hinglishMarkers = [
      /\b(banao|karo|karna|chahiye|hona|honi|khet|gaon|gaav|kisan|aurat|mahila|bachche|khana|rahe|raha|subah|shaam|sham|raat|barish|dhoop|safed|peela|neela|lal|laal|pani|paani|kutta|gadi|shahar|isko|usko|mat|dikhao|batao|samjhao|kaise|hota|kya|kyun|hai|hain|tha|thi|ke|ki|ka|se|par|me|mein|hum|aap|tum|thoda|jyada|bahut|accha|acha|sahi|galti|theek|badlo|kahan|idhar|udhar)\b/i,
    ];

    if (hinglishMarkers.some((pattern) => pattern.test(text))) {
      return "hinglish";
    }

    // 3. Indian English Idioms & Collocations
    const indianEnglishMarkers = [
      /\b(do\s+one\s+thing)\b/i,
      /\b(revert\s+back)\b/i,
      /\b(doubt\s+regarding)\b/i,
      /\b(prepone)\b/i,
      /\b(out\s+of\s+station)\b/i,
      /\b(do\s+the\s+needful)\b/i,
      /\b(pass\s+out\s+batch)\b/i,
      /\b(upgradation)\b/i,
      /\b(what\s+is\s+your\s+good\s+name)\b/i,
      /\b(today\s+morning|yesterday\s+night)\b/i,
      /\b(kindly\s+revert|kindly\s+check)\b/i,
    ];

    if (indianEnglishMarkers.some((pattern) => pattern.test(text))) {
      return "indian_english";
    }

    return "english";
  }

  /**
   * Classifies user input into one of the core system intents.
   */
  classifyIntent(text: string): CoreIntent {
    const lower = text.toLowerCase();

    // 1. Memory / Identity operations
    if (
      /\b(what is my name|who am i|do you remember me|where am i from|mera naam kya hai|yaad hai|kahan se hu)\b/i.test(lower)
    ) {
      return "MEMORY_OPERATION";
    }

    // 2. Admin operations
    if (
      /\b(quota|token usage|rate limit|system metrics|server status|admin dashboard|storage stats)\b/i.test(lower)
    ) {
      return "ADMIN_OPERATION";
    }

    // 3. Document QA / RAG
    if (
      /\b(according to document|in the document|based on file|search documents|untrusted-document-content|citations|dastavez|kagaz)\b/i.test(lower)
    ) {
      return "DOCUMENT_QA";
    }

    // 4. Image Generation
    if (
      /\b(image|photo|picture|drawing|painting|portrait|art|scene|wallpaper|visualize|render|banao|photo banao|tasveer|chitra)\b/i.test(lower) &&
      !/\b(code|python|script|test|debug|function|class|algorithm)\b/i.test(lower)
    ) {
      return "IMAGE_GENERATION";
    }

    // 5. Coding Tasks
    if (
      /\b(code|coding|function|script|debug|unit\s+test|test\s+suite|tests?|refactor|python|javascript|typescript|c\+\+|bug|error|stack\s*trace|assertion|algorithm|implement|git\s+commit)\b/i.test(lower) ||
      /\b(fix|diagnose|repair)\b.*\b(test|bug|failure|error)\b/i.test(lower)
    ) {
      return "CODING_TASK";
    }

    // 6. Video Generation
    if (
      /\b(video|animation|movie|clip|film|storyboard|cinematic trailer|zoompan|scenes)\b/i.test(lower)
    ) {
      return "VIDEO_GENERATION";
    }

    // 7. Audio Synthesis
    if (
      /\b(audio|speech|voice|narrate|narration|podcast|tts|sound|synthesize voice|bol ke sunao|aawaz)\b/i.test(lower)
    ) {
      return "AUDIO_SYNTHESIS";
    }

    // 8. Autonomous Task / Pipeline Orchestration
    if (
      /\b(task|plan|workflow|autonomous|pipeline|dag|execute pipeline|automate|steps)\b/i.test(lower)
    ) {
      return "TASK_EXECUTION";
    }

    return "CHAT_REASONING";
  }

  /**
   * Maps a CoreIntent to the appropriate UI/System Module.
   */
  mapToTargetModule(intent: CoreIntent): TargetModule {
    switch (intent) {
      case "IMAGE_GENERATION": return "images";
      case "CODING_TASK": return "coding";
      case "VIDEO_GENERATION": return "videos";
      case "AUDIO_SYNTHESIS": return "audio";
      case "DOCUMENT_QA": return "ask";
      case "TASK_EXECUTION": return "tasks";
      case "MEMORY_OPERATION": return "memory";
      case "ADMIN_OPERATION": return "admin";
      case "CHAT_REASONING":
      default:
        return "chat";
    }
  }

  /**
   * Identifies if the prompt is an iterative revision of a previous turn.
   */
  detectRevision(text: string): boolean {
    const revisionMarkers = [
      /\b(same\s+(image|photo|picture|result|style|code|function))\b/i,
      /\b(isko|usko)\s+(improve|badlo|change|sahi|aur)\b/i,
      /\b(make\s+it\s+(more|less|better|realistic|professional|faster|shorter))\b/i,
      /\b(instead\s+of|replace|change\s+to|change\s+the)\b/i,
      /\b(in\s+(evening|morning|night|dawn|sunset)\s+light)\b/i,
      /\b(woman\s+ki|sari|shirt|color|colour)\s+(red|blue|yellow|green|honi|kardo)\b/i,
      /\b(continue\s+from|previous\s+result|pichla|agle\s+step)\b/i,
      /\b(add\s+more|remove\s+the|without\s+changing)\b/i,
      /\b(now\s+in\s+(python|javascript|typescript|c\+\+))\b/i,
      /\b(another\s+way|alternative|differently)\b/i,
    ];

    return revisionMarkers.some((regex) => regex.test(text));
  }

  /**
   * Extracts negative constraints, preserved invariants, explicit format requirements, and detects conflicts.
   */
  extractConstraints(text: string): {
    negativeConstraints: string[];
    preservedConstraints: string[];
    explicitConstraints: string[];
    conflicts: string[];
    unresolvedAmbiguity: string[];
  } {
    const negativeConstraints: string[] = [];
    const preservedConstraints: string[] = [];
    const explicitConstraints: string[] = [];
    const conflicts: string[] = [];
    const unresolvedAmbiguity: string[] = [];

    const lower = text.toLowerCase();

    // 1. Negative constraints in English
    const negativePatterns = [
      /(?:without|excluding|free of)\s+([a-zA-Z0-9_\-\s]+?)(?:\.|$|,|\band\b)/gi,
      /(?:avoid)\s+([a-zA-Z0-9_\-\s]+?)(?:\.|$|,|\band\b)/gi,
      /(?:dont|don't|do not)\s+(?:include|show|add|put|use|modify|change)\s+([a-zA-Z0-9_\-\s]+?)(?:\.|$|,|\band\b)/gi,
      /(?:never)\s+(?:use|include|call|modify)\s+([a-zA-Z0-9_\-\s]+?)(?:\.|$|,|\band\b)/gi,
      /(?:not|no)\s+(javascript|js|recursion|cars|dependencies|external libraries)\b/gi,
    ];

    for (const pattern of negativePatterns) {
      let match: RegExpExecArray | null;
      while ((match = pattern.exec(text)) !== null) {
        let item = match[1].trim().toLowerCase();
        if (item.includes("meaning") || item.includes("original") || item.includes("style") || item.includes("composition") || item.includes("important information")) {
          continue;
        }
        item = item.replace(/\b(and|or|with|also|the|any)\b/g, "").replace(/\s+/g, " ").trim();
        if (item && !negativeConstraints.includes(item)) {
          negativeConstraints.push(item);
        }
      }
    }

    // Specific English negative constraint keywords
    if (/\bdo not add dependencies\b|\bno dependencies\b|\bwithout dependencies\b/i.test(text)) {
      if (!negativeConstraints.includes("dependencies")) negativeConstraints.push("dependencies");
    }
    if (/\bdo not modify any other file\b|\bno other files\b|\bwithout touching other files\b/i.test(text)) {
      if (!negativeConstraints.includes("modify other files")) negativeConstraints.push("modify other files");
      if (!preservedConstraints.includes("PRESERVE_UNMODIFIED_FILES")) preservedConstraints.push("PRESERVE_UNMODIFIED_FILES");
    }
    if (/\b(?:not javascript|use typescript,?\s*not javascript)\b/i.test(text)) {
      if (!negativeConstraints.includes("javascript")) negativeConstraints.push("javascript");
    }

    // 2. Negative constraints in Hinglish / Devanagari Hindi
    const hinglishNegativePatterns = [
      /(?:koi\s+)?([a-zA-Z0-9_\-\s]+?)\s+(?:mat\s+(?:dikhana|karna|rakhna|banao|use karo)|nahi\s+hona\s+chahiye|mat\s+daalo)/gi,
      /(?:bina|bina\s+kisi)\s+([a-zA-Z0-9_\-\s]+?)(?:\s+ke|\.|$|,)/gi,
      /([a-zA-Z0-9_\-\s]+?)\s+hatao/gi,
    ];

    for (const pattern of hinglishNegativePatterns) {
      let match: RegExpExecArray | null;
      while ((match = pattern.exec(text)) !== null) {
        let item = match[1].trim().toLowerCase();
        if (item.includes("meaning") || item.includes("original") || item.includes("style") || item.includes("baaki")) {
          continue;
        }
        item = item.replace(/\b(and|or|with|also|ke|koi)\b/g, "").replace(/\s+/g, " ").trim();
        if (item && !negativeConstraints.includes(item)) {
          negativeConstraints.push(item);
        }
      }
    }

    // Normalize vernacular negative terms
    if (negativeConstraints.includes("gaadi") || negativeConstraints.includes("gadi")) {
      if (!negativeConstraints.includes("cars")) negativeConstraints.push("cars");
    }

    // 3. Preservation constraints
    if (
      /original\s+meaning\s+change\s+mat\s+karna/i.test(text) ||
      /do\s+not\s+change\s+(?:the\s+)?original\s+meaning/i.test(text) ||
      /keep\s+(?:the\s+)?original\s+meaning/i.test(text) ||
      /preserve\s+(?:semantic\s+)?meaning/i.test(text)
    ) {
      preservedConstraints.push("PRESERVE_SEMANTIC_MEANING");
    }

    if (
      /keep\s+(?:the\s+)?same\s+composition/i.test(text) ||
      /same\s+(?:style|composition|view)/i.test(text) ||
      /composition\s+(?:change\s+mat|same\s+rakho)/i.test(text) ||
      /preserve\s+(?:style|composition)/i.test(text)
    ) {
      preservedConstraints.push("PRESERVE_STYLE_AND_COMPOSITION");
    }

    if (
      /only\s+change\s+(?:the\s+)?lighting/i.test(text) ||
      /sirf\s+lighting\s+(?:badlo|change\s+karo)/i.test(text)
    ) {
      preservedConstraints.push("PRESERVE_ALL_EXCEPT_LIGHTING");
      explicitConstraints.push("DELTA_LIGHTING_ONLY");
    }

    if (
      /sirf\s+sari\s+ka\s+color\s+red\s+karo/i.test(text) ||
      /only\s+change\s+(?:the\s+)?(?:sari|dress)\s+(?:color\s+)?to\s+red/i.test(text) ||
      /baaki\s+same\s+rakho/i.test(text)
    ) {
      preservedConstraints.push("PRESERVE_ALL_EXCEPT_TARGET");
      explicitConstraints.push("TARGET_COLOR_RED");
      explicitConstraints.push("TARGET_ELEMENT_SARI");
    }

    if (
      /without\s+removing\s+important\s+information/i.test(text) ||
      /preserve\s+important\s+information/i.test(text) ||
      /jaruri\s+baatein\s+mat\s+hatana/i.test(text)
    ) {
      preservedConstraints.push("PRESERVE_ESSENTIAL_INFORMATION");
    }

    if (/keep\s+existing\s+tests/i.test(text) || /do\s+not\s+break\s+existing/i.test(text)) {
      preservedConstraints.push("PRESERVE_EXISTING_TESTS");
    }

    // 4. Explicit format constraints
    if (/\b(?:typescript|ts)\b/i.test(text) && !/\bnot\s+typescript\b/i.test(text)) {
      explicitConstraints.push("FORMAT_TYPESCRIPT");
    }
    if (/\b(?:python|py)\b/i.test(text) && !/\bnot\s+python\b/i.test(text)) {
      explicitConstraints.push("FORMAT_PYTHON");
    }
    if (/\b(?:javascript|js)\b/i.test(text) && !/\bnot\s+(?:javascript|js)\b/i.test(text) && !negativeConstraints.includes("javascript")) {
      explicitConstraints.push("FORMAT_JAVASCRIPT");
    }
    if (/o\s*\(\s*log\s*n\s*\)|logarithmic/i.test(text)) {
      explicitConstraints.push("COMPLEXITY_O_LOG_N");
    }
    if (/\b(step-by-step|step by step)\b/i.test(text)) {
      explicitConstraints.push("STEP_BY_STEP_EXPLANATION");
    }
    if (/\b(simple terms|easy to understand|saral)\b/i.test(text)) {
      explicitConstraints.push("SIMPLIFIED_EXPLANATION");
    }
    if (/explain\s+in\s+hindi.*keep\s+technical\s+terms\s+in\s+english/i.test(text) || /hindi\s+me.*technical\s+terms\s+english/i.test(text)) {
      explicitConstraints.push("EXPLAIN_HINDI");
      explicitConstraints.push("TECHNICAL_TERMS_ENGLISH");
    }
    if (/\b(?:make\s+it\s+shorter|make\s+shorter|more\s+concise|briefly)\b/i.test(text)) {
      explicitConstraints.push("CONCISE_SUMMARY");
    }

    // 5. Conflict Detection & Explicit Priority Resolution
    // (a) Language Conflict: TypeScript requested AND JavaScript requested simultaneously as output format
    if (explicitConstraints.includes("FORMAT_TYPESCRIPT") && explicitConstraints.includes("FORMAT_JAVASCRIPT")) {
      if (negativeConstraints.includes("javascript")) {
        // Resolved: TypeScript explicitly chosen, JavaScript negated
        const idx = explicitConstraints.indexOf("FORMAT_JAVASCRIPT");
        if (idx !== -1) explicitConstraints.splice(idx, 1);
      } else {
        conflicts.push("CONFLICT: Mutually exclusive formats requested (TypeScript vs JavaScript).");
        unresolvedAmbiguity.push("Please specify whether you prefer TypeScript or JavaScript.");
      }
    }

    // (b) Recursion Conflict: recursion positively requested AND negated in the same prompt
    if (lower.includes("with recursion") && (lower.includes("without recursion") || negativeConstraints.includes("recursion"))) {
      conflicts.push("CONFLICT: Prompt requests both recursive and non-recursive implementation.");
      // Explicit priority: negative constraint overrules positive
      if (!negativeConstraints.includes("recursion")) negativeConstraints.push("recursion");
    }

    // (c) Length Conflict: make it shorter AND comprehensive/in-depth
    if (explicitConstraints.includes("CONCISE_SUMMARY") && (lower.includes("in-depth") || lower.includes("detailed explanation") || lower.includes("very long"))) {
      conflicts.push("CONFLICT: Prompt requests concise summary and exhaustive in-depth detail simultaneously.");
      unresolvedAmbiguity.push("Please clarify whether you desire a brief summary or comprehensive deep dive.");
    }

    return {
      negativeConstraints,
      preservedConstraints,
      explicitConstraints,
      conflicts,
      unresolvedAmbiguity,
    };
  }

  /**
   * Extracts entities: user attributes, code files, test files, technologies, visual subjects, search terms.
   */
  extractEntities(text: string): IntentEntities {
    const entities: IntentEntities = {};

    // 1. User Identity & Location
    const nameMatch = text.match(/(?:my name is|call me|i am|i'm|naam hai|naam)\s+([A-Z][a-z]+)\b/i);
    if (nameMatch) {
      entities.userName = nameMatch[1].charAt(0).toUpperCase() + nameMatch[1].slice(1).toLowerCase();
    }

    const cityMatch = text.match(/(?:from|live in|located in|rehta hu|rehti hu)\s+([A-Z][a-z]+)\b/i);
    if (cityMatch) {
      entities.userCity = cityMatch[1].charAt(0).toUpperCase() + cityMatch[1].slice(1).toLowerCase();
    }

    const roleMatch = text.match(/(?:i am a|i'm a|work as a|working as a|profession is)\s+([A-Za-z\s]+?)(?:\s+from|\s+in|\.|\,|$|\n)/i);
    if (roleMatch) {
      entities.userRole = roleMatch[1].trim();
    }

    // 2. Code & Test Files
    const testMatches = text.match(/([a-zA-Z0-9_\-\.\/]+\.test\.[a-zA-Z0-9]+)/g);
    if (testMatches) {
      entities.testFiles = Array.from(new Set(testMatches));
    }

    const fileMatches = text.match(/([a-zA-Z0-9_\-\.\/]+\.(?:js|ts|py|cpp|c|h|json|md|html|css))/g);
    if (fileMatches) {
      entities.codeFiles = Array.from(new Set(fileMatches.filter((f) => !f.includes(".test."))));
    }

    // 3. Technologies
    const techPatterns = /\b(typescript|javascript|python|c\+\+|node|vitest|jest|playwright|react|next\.js|fastify|drizzle|pglite|ffmpeg|opencv)\b/gi;
    const techMatches = text.match(techPatterns);
    if (techMatches) {
      entities.technologies = Array.from(new Set(techMatches.map((t) => t.toLowerCase())));
    }

    // 4. Numbers
    const numMatches = text.match(/\b\d+(?:\.\d+)?\b/g);
    if (numMatches) {
      entities.numbers = numMatches.map((n) => parseFloat(n));
    }

    // 5. Visual subjects
    const visualPatterns = /\b(village|farmer|kisan|lighthouse|temple|butterfly|mountain|river|ocean|robot|cyberpunk city|woman|man|children|sunset|dawn)\b/gi;
    const visualMatches = text.match(visualPatterns);
    if (visualMatches) {
      entities.visualSubjects = Array.from(new Set(visualMatches.map((v) => v.toLowerCase())));
    }

    return entities;
  }

  /**
   * Expands vernacular Hindi / Hinglish concepts for realistic image diffusion prompts.
   */
  normalizeVernacularConcepts(text: string): string {
    let normalized = text;

    const vernacularMap: Array<{ regex: RegExp; replacement: string }> = [
      { regex: /\b(village|gaon|gaav)\b/gi, replacement: "rural Indian village with mud houses and rustic courtyards" },
      { regex: /\bkisan\b/gi, replacement: "Indian farmer with weathered features in traditional attire" },
      { regex: /\b(old\s+man|buddha\s+aadmi|vriddha\s+purush)\b/gi, replacement: "elderly Indian man with silver hair and warm expression" },
      { regex: /\b(old\s+woman|buddhi\s+aurat|vriddha\s+mahila)\b/gi, replacement: "elderly Indian woman with silver hair and kind expression" },
      { regex: /\b(aurat|mahila)\b/gi, replacement: "Indian woman in traditional attire" },
      { regex: /\b(khana\s+bana\s+(?:rahe|rahi|raha)\s*(?:hain|hai)?|cooking)\b/gi, replacement: "cooking fresh food over a traditional outdoor clay chulha stove" },
      { regex: /\b(bachche\s+(?:khaa|kha)\s+rahe\s*(?:hain)?|children\s+eating)\b/gi, replacement: "village children sitting nearby happily eating food" },
      { regex: /\b(woman\s+ki\s+sari\s+red|sari\s+red\s+honi\s+chahiye|laal\s+sari)\b/gi, replacement: "woman dressed in an elegant vibrant red traditional cotton sari with golden border" },
      { regex: /\b(evening\s+light|shaam\s+ka\s+samay|sunset)\b/gi, replacement: "warm golden hour evening sunset lighting with soft dramatic shadows" },
      { regex: /\b(realistic|asali|real)\b/gi, replacement: "photorealistic cinematic National Geographic style photography, 8k resolution, highly detailed" },
      { regex: /\b(titli)\b/gi, replacement: "vibrant butterfly with detailed wings" },
      { regex: /\b(phool)\b/gi, replacement: "fresh blooming flowers with delicate petals" },
      { regex: /\b(paani|pani)\b/gi, replacement: "crystal clear transparent water with realistic refractions" },
      { regex: /\b(seb)\b/gi, replacement: "fresh crisp red apple with natural textures" },
      { regex: /\b(mandir)\b/gi, replacement: "ancient stone Indian temple with carved pillars" },
      { regex: /\b(chai\s+tapri)\b/gi, replacement: "rustic Indian roadside tea stall with clay cups and steaming kettle" },
      { regex: /\b(khet)\b/gi, replacement: "lush green Indian agricultural farmland under open sky" },
      { regex: /\b(tractor)\b/gi, replacement: "classic red agricultural tractor parked in field" },
    ];

    for (const item of vernacularMap) {
      normalized = normalized.replace(item.regex, item.replacement);
    }

    return normalized;
  }

  /**
   * Expands vernacular Hindi / Hinglish query concepts to canonical English terms for lexical & vector RAG retrieval.
   */
  expandCrossLingualRagTerms(text: string): string[] {
    const rawTokens = text.toLowerCase().split(/\s+/);
    const searchTerms = new Set<string>();

    const dictionary: Record<string, string[]> = {
      pradhan: ["prime", "minister", "head"],
      mantri: ["minister", "cabinet"],
      sarkar: ["government", "administration", "policy"],
      naukri: ["job", "career", "employment", "recruitment"],
      kaam: ["work", "job", "task"],
      paisa: ["price", "cost", "billing", "payment", "fee"],
      rupaye: ["price", "cost", "inr", "payment"],
      kharach: ["expense", "cost", "budget"],
      shiksha: ["education", "learning", "study", "university"],
      padhai: ["education", "study", "course"],
      suraksha: ["security", "safety", "protection", "authentication"],
      dastavez: ["document", "file", "record"],
      kagaz: ["document", "paper", "file"],
      niyam: ["rules", "policy", "regulations", "guidelines"],
      kanoon: ["law", "rules", "policy"],
      madad: ["help", "support", "assistance"],
      sahayata: ["help", "support", "assistance"],
      galti: ["error", "bug", "defect", "fault"],
      truti: ["error", "defect", "exception"],
      kisan: ["farmer", "agriculture", "crops"],
      khet: ["field", "farmland", "agriculture"],
      samay: ["time", "duration", "schedule"],
      waqt: ["time", "duration"],
    };

    for (const token of rawTokens) {
      const cleanToken = token.replace(/[^a-z0-9]/g, "");
      if (cleanToken.length >= 3) {
        searchTerms.add(cleanToken);
      }
      if (dictionary[cleanToken]) {
        for (const term of dictionary[cleanToken]) {
          searchTerms.add(term);
        }
      }
    }

    return Array.from(searchTerms);
  }

  /**
   * Processes a conversation turn, maintaining session context and extracting a structured intent representation.
   */
  processTurn(sessionId: string, userInput: string, options: IntentProcessOptions = {}): IntentState {
    const rawText = (userInput || "").trim();
    const lang = this.detectLanguage(rawText);
    const intent = options.forcedIntent || this.classifyIntent(rawText);
    const targetModule = options.targetModule || this.mapToTargetModule(intent);
    const isRevision = this.detectRevision(rawText);
    const { negativeConstraints, preservedConstraints, explicitConstraints, conflicts, unresolvedAmbiguity } = this.extractConstraints(rawText);
    const entities = this.extractEntities(rawText);

    const prevContext = this.sessionContext.get(sessionId) || null;

    let basePrompt = rawText;
    let enhancedPrompt = "";
    const effectiveNegatives = [...negativeConstraints];
    const requiredActions: string[] = [];
    let subIntent = "GENERAL";
    let outputFormat = "markdown_text";
    const completionCriteria: string[] = [];
    let expectedOutput = "Accurate response satisfying user requirements";

    // -------------------------------------------------------------------------
    // Module-specific orchestration & representation synthesis
    // -------------------------------------------------------------------------
    if (intent === "IMAGE_GENERATION") {
      subIntent = isRevision ? "DIFFUSION_REVISION" : "DIFFUSION_SYNTHESIS";
      outputFormat = "image_diffusion";
      requiredActions.push("enrich_prompt", "apply_negatives", "dispatch_diffusion_inference", "store_artifact");
      completionCriteria.push("image_artifact_created", "semantic_correspondence_verified", "negative_terms_excluded");
      expectedOutput = "High-resolution photorealistic image matching semantic description";

      if (isRevision && prevContext && prevContext.enhancedPrompt) {
        let merged = prevContext.enhancedPrompt;

        if (/\b(evening|sunset|shaam|sun\s+setting)\b/i.test(rawText)) {
          merged = merged.replace(/natural\s+daylight|morning\s+sunlight|dawn/gi, "warm golden hour evening sunset lighting");
          if (!merged.includes("golden hour evening")) {
            merged += ", warm golden hour evening sunset lighting with long soft shadows";
          }
        }

        if (/\b(red\s+sari|sari\s+red|laal\s+sari)\b/i.test(rawText)) {
          merged = merged.replace(/traditional\s+attire/gi, "vibrant red traditional sari with golden embroidery");
          if (!merged.includes("vibrant red")) {
            merged += ", the woman is wearing a vibrant red traditional Indian sari";
          }
        }

        if (/\b(more\s+realistic|professional|improve)\b/i.test(rawText)) {
          if (!merged.includes("award winning")) {
            merged += ", professional award-winning photographic clarity, sharp focus, 8k resolution";
          }
        }

        enhancedPrompt = merged;
        basePrompt = `Revision of: "${prevContext.originalPrompt}" -> Modifications: ${rawText}`;
      } else {
        const normalized = this.normalizeVernacularConcepts(rawText);
        enhancedPrompt = normalized;
        if (!/\b(photorealistic|photography|cinematic|detailed)\b/i.test(enhancedPrompt)) {
          enhancedPrompt += ", photorealistic cinematic photography, natural lighting, highly detailed, 8k resolution";
        }
      }

      // Default negative prompt to prevent artifacts
      const defaultNegatives = [
        "blurry",
        "distorted anatomy",
        "extra limbs",
        "low quality",
        "bad proportions",
        "duplicate",
        "text",
        "watermark",
        "logo",
        "caption",
        "username",
        "signature",
      ];
      for (const def of defaultNegatives) {
        if (!effectiveNegatives.includes(def)) {
          effectiveNegatives.push(def);
        }
      }
    } else if (intent === "CODING_TASK") {
      subIntent = rawText.toLowerCase().includes("fix") ? "BUG_FIX" : "FEATURE_IMPLEMENTATION";
      outputFormat = "code_patch";
      requiredActions.push("locate_test_failure", "read_source_file", "apply_code_patch", "run_test_verification");
      completionCriteria.push("test_suite_passes", "exit_code_zero", "invariants_preserved");
      expectedOutput = "Executable code patch with successful test pass";
      enhancedPrompt = rawText;
    } else if (intent === "TASK_EXECUTION") {
      subIntent = "MULTI_STEP_PIPELINE";
      outputFormat = "dag_workflow";
      requiredActions.push("decompose_steps", "validate_dependencies", "execute_stepwise", "synthesize_report");
      completionCriteria.push("all_dag_nodes_completed", "error_rate_zero");
      expectedOutput = "Execution report for planned workflow steps";
      enhancedPrompt = rawText;
    } else if (intent === "DOCUMENT_QA") {
      subIntent = "CITATION_GROUNDED_QA";
      outputFormat = "rag_answer_with_citations";
      requiredActions.push("extract_cross_lingual_terms", "retrieve_passages", "verify_grounding", "generate_citations");
      completionCriteria.push("truthful_citations_included", "refusal_if_ungrounded");
      expectedOutput = "Grounded answer with direct citations [1], [2] to retrieved sources";
      enhancedPrompt = rawText;
    } else if (intent === "AUDIO_SYNTHESIS") {
      subIntent = "VOICE_NARRATION";
      outputFormat = "audio_wav";
      requiredActions.push("phonetic_preprocessing", "synthesize_pcm_stream", "encode_wav_header", "verify_duration");
      completionCriteria.push("playable_audio_generated", "duration_above_threshold");
      expectedOutput = "Synthesized speech WAV audio file";
      enhancedPrompt = rawText;
    } else if (intent === "VIDEO_GENERATION") {
      subIntent = "STORYBOARD_COMPOSITION";
      outputFormat = "video_mp4";
      requiredActions.push("compose_scenes", "render_frames", "synthesize_audio", "mux_mp4_container");
      completionCriteria.push("valid_mp4_produced", "audio_video_synchronized");
      expectedOutput = "Rendered MP4 video with synced narration";
      enhancedPrompt = rawText;
    } else {
      subIntent = "CONVERSATIONAL_REASONING";
      outputFormat = "markdown_text";
      requiredActions.push("contextual_reasoning", "multi_turn_profile_recall", "satisfaction_formatting");
      completionCriteria.push("user_question_answered", "constraints_honored");
      expectedOutput = "Clear, accurate conversational response";
      enhancedPrompt = rawText;
    }

    const state: IntentState = {
      sessionId,
      timestamp: Date.now(),
      originalPrompt: rawText,
      detectedLanguage: lang,
      targetModule,
      intent,
      subIntent,
      isRevision,
      requiredActions,
      explicitConstraints,
      negativeConstraints: effectiveNegatives,
      preservedConstraints,
      outputFormat,
      contextReferences: prevContext ? [prevContext.originalPrompt] : [],
      userPreferences: options.userPreferences || {},
      relevantPriorArtifacts: options.priorArtifacts || [],
      assumptions: conflicts && conflicts.length > 0 ? conflicts : [],
      unresolvedAmbiguity: unresolvedAmbiguity || [],
      completionCriteria,
      expectedOutput,
      enhancedPrompt,
      basePrompt,
      entities,
    };

    this.sessionContext.set(sessionId, state);
    return state;
  }

  // ---------------------------------------------------------------------------
  // Module-Specific Adapters
  // ---------------------------------------------------------------------------

  /**
   * Adapts IntentState for Chat reasoning and personalization.
   */
  adaptForChat(state: IntentState): ChatIntentAdapter {
    const rawLower = state.originalPrompt.toLowerCase();
    const isCode = state.intent === "CODING_TASK" || /\b(code|function|class|typescript|python|c\+\+)\b/i.test(rawLower);
    const isMath = /\b(\d+\s*[\+\-\*\/%^]\s*\d+|calculate|evaluate)\b/i.test(rawLower);
    const isMemory = state.intent === "MEMORY_OPERATION" || /\b(who am i|my name|remember me)\b/i.test(rawLower);

    let style: "concise" | "in_depth" | "socratic" | "code_first" = "in_depth";
    if (state.explicitConstraints.includes("SIMPLIFIED_EXPLANATION") || isMath) {
      style = "concise";
    } else if (isCode) {
      style = "code_first";
    }

    return {
      topic: state.entities.technologies?.[0] || state.subIntent,
      userProfile: {
        name: state.entities.userName,
        city: state.entities.userCity,
        role: state.entities.userRole,
      },
      reasoningStyle: style,
      languageModality: state.detectedLanguage,
      isCodeRequest: isCode,
      isMathCalculation: isMath,
      requiresMemoryRecall: isMemory,
      constraints: [...state.explicitConstraints, ...state.preservedConstraints],
    };
  }

  /**
   * Adapts IntentState into an executable Task workflow DAG.
   */
  adaptForTasks(state: IntentState): TaskIntentAdapter {
    const steps: TaskIntentStep[] = [];

    if (state.intent === "CODING_TASK") {
      steps.push({
        stepIndex: 1,
        title: "Diagnose Test Failure",
        toolRequired: "terminal.run_command",
        description: `Run failing test suite ${state.entities.testFiles?.[0] || "test suite"} to capture assertion stack trace`,
        dependencies: [],
        acceptanceCriteria: "Captured failing assertion and line number",
      });
      steps.push({
        stepIndex: 2,
        title: "Apply Code Patch",
        toolRequired: "code.replace_text",
        description: `Apply targeted code modification in ${state.entities.codeFiles?.[0] || "source file"} to satisfy assertions`,
        dependencies: [1],
        acceptanceCriteria: "File modified cleanly without syntax errors",
      });
      steps.push({
        stepIndex: 3,
        title: "Verify Test Pass",
        toolRequired: "terminal.run_command",
        description: "Re-run test suite to confirm exit code 0 and all tests passing",
        dependencies: [2],
        acceptanceCriteria: "Test suite exits with code 0 PASS",
      });
    } else if (state.intent === "IMAGE_GENERATION") {
      steps.push({
        stepIndex: 1,
        title: "Normalize Vernacular & Constraints",
        toolRequired: "intent_engine.processTurn",
        description: "Enrich prompt with photographic quality markers and negative constraints",
        dependencies: [],
        acceptanceCriteria: "Structured image prompt generated",
      });
      steps.push({
        stepIndex: 2,
        title: "Execute Cloud Diffusion Inference",
        toolRequired: "media.image_generation",
        description: "Dispatch text prompt to FLUX.1 diffusion engine",
        dependencies: [1],
        acceptanceCriteria: "Valid image bytes returned",
      });
    } else {
      steps.push({
        stepIndex: 1,
        title: "Analyze Requirements",
        toolRequired: "agent.plan",
        description: `Analyze objectives and constraints for: ${state.originalPrompt.slice(0, 60)}`,
        dependencies: [],
        acceptanceCriteria: "Plan generated",
      });
      steps.push({
        stepIndex: 2,
        title: "Execute Core Action",
        toolRequired: "agent.execute",
        description: "Execute primary planned actions",
        dependencies: [1],
        acceptanceCriteria: "Actions completed successfully",
      });
    }

    return {
      workflowGoal: state.originalPrompt,
      steps,
      targetModule: state.targetModule,
      estimatedComplexity: steps.length > 2 ? "high" : "medium",
    };
  }

  /**
   * Adapts IntentState for autonomous coding and test repair.
   */
  adaptForCoding(state: IntentState): CodingIntentAdapter {
    const rawLower = state.originalPrompt.toLowerCase();
    let lang: "typescript" | "javascript" | "python" | "cpp" | "unknown" = "unknown";

    if (rawLower.includes("python") || rawLower.includes(".py")) lang = "python";
    else if (rawLower.includes("typescript") || rawLower.includes(".ts")) lang = "typescript";
    else if (rawLower.includes("javascript") || rawLower.includes(".js")) lang = "javascript";
    else if (rawLower.includes("c++") || rawLower.includes("cpp")) lang = "cpp";

    const testFile = state.entities.testFiles?.[0] || "math.test.js";
    const targetFile = state.entities.codeFiles?.[0] || "math.js";

    let testCommand = "node";
    let testArgs = [testFile];
    if (lang === "python") {
      testCommand = "python";
      testArgs = ["-m", "pytest", testFile];
    }

    return {
      testFile,
      targetFile,
      language: lang,
      actionType: rawLower.includes("fix") ? "fix_test" : "write_feature",
      testCommand,
      testArgs,
      cwd: "coding-demo",
      errorSymptom: state.originalPrompt,
      expectedBehavior: "All unit tests pass with exit code 0",
    };
  }

  /**
   * Adapts IntentState for Image generation and diffusion pipelines.
   */
  adaptForImages(state: IntentState): ImageIntentAdapter {
    return {
      subject: state.entities.visualSubjects?.[0] || "subject",
      positivePrompt: state.enhancedPrompt,
      negativePrompt: state.negativeConstraints.join(", "),
      lighting: state.enhancedPrompt.includes("golden hour") ? "golden_hour_sunset" : "natural_lighting",
      style: "photorealistic_cinematic",
      aspectRatio: "1:1",
      width: 512,
      height: 512,
      isRevision: state.isRevision,
      preservations: state.preservedConstraints,
    };
  }

  /**
   * Adapts IntentState for grounded Ask/RAG retrieval.
   */
  adaptForAskRAG(state: IntentState): RagIntentAdapter {
    const canonicalTerms = this.expandCrossLingualRagTerms(state.originalPrompt);
    return {
      rawQuery: state.originalPrompt,
      canonicalEnglishTerms: canonicalTerms,
      extractedEntities: state.entities.searchTerms || [],
      requiresGroundedCitations: true,
      refusalOnEmpty: true,
    };
  }

  /**
   * Adapts IntentState for Audio / Video synthesis pipelines.
   */
  adaptForMedia(state: IntentState): MediaIntentAdapter {
    const isVideo = state.intent === "VIDEO_GENERATION";
    return {
      mediaType: isVideo ? "video" : "audio",
      narrationScript: state.originalPrompt,
      targetDurationSeconds: isVideo ? 4 : 5,
      voiceGender: "neutral",
      scenes: isVideo
        ? [
            {
              sceneIndex: 1,
              visualPrompt: state.enhancedPrompt,
              narrationChunk: state.originalPrompt.slice(0, 80),
            },
          ]
        : undefined,
    };
  }

  /**
   * Clears session context on demand.
   */
  clearSession(sessionId: string): void {
    this.sessionContext.delete(sessionId);
  }
}

export const sharedIntentEngine = new ConversationalIntentEngine();
