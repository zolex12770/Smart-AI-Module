/**
 * Nirnay.AI Shared Conversational Intent Engine
 * 
 * Provides robust natural-language intent extraction, multilingual (English, Hindi, Hinglish)
 * prompt normalization, multi-turn reference resolution, and constraint preservation.
 */

export class ConversationalIntentEngine {
  constructor() {
    this.sessionContext = new Map(); // sessionId -> previous intent state
  }

  /**
   * Detects the linguistic modality of the input text.
   */
  detectLanguage(text) {
    if (!text || typeof text !== "string") return "unknown";
    
    // Check for Devanagari Unicode block (\u0900-\u097F)
    const devanagariRegex = /[\u0900-\u097F]/;
    if (devanagariRegex.test(text)) {
      return "hindi_devanagari";
    }

    // Common Hinglish / Romanized Hindi keywords
    const hinglishMarkers = [
      /\b(banao|karo|chahiye|hona|honi|khet|gaon|kisan|aurat|mahila|bachche|khana|rahe|raha|subah|shaam|sham|raat|barish|dhoop|safed|peela|neela|lal|pani|kutta|gadi|shahar|isko|usko|mat|karna|dikhao|batao|samjhao|kaise|hota|kya|kyun|hai|hain|tha|thi|ke|ki|ka|se|par|me|mein)\b/i,
    ];

    if (hinglishMarkers.some((pattern) => pattern.test(text))) {
      return "hinglish";
    }

    return "english";
  }

  /**
   * Identifies the primary task intent from the input and context.
   */
  classifyIntent(text) {
    const lower = text.toLowerCase();

    // Check for Image generation intent
    if (
      /\b(image|photo|picture|drawing|painting|portrait|art|scene|wallpaper|visualize|render|banao|photo banao|tasveer)\b/i.test(lower) &&
      !/\b(code|python|script|test|debug|function|class)\b/i.test(lower)
    ) {
      return "IMAGE_GENERATION";
    }

    // Check for Coding intent
    if (/\b(code|coding|function|script|debug|fix test|refactor|python|javascript|typescript|bug|error|stack trace|algorithm|implement|git)\b/i.test(lower)) {
      return "CODING_TASK";
    }

    // Check for Video generation intent
    if (/\b(video|animation|movie|clip|film|storyboard|scenes|cinematic trailer)\b/i.test(lower)) {
      return "VIDEO_GENERATION";
    }

    // Check for Audio / Speech intent
    if (/\b(audio|speech|voice|narrate|podcast|tts|sound|synthesize voice|bol ke sunao)\b/i.test(lower)) {
      return "AUDIO_SYNTHESIS";
    }

    // Check for Task / Agent orchestration
    if (/\b(task|plan|workflow|autonomous|steps|execute pipeline|automate)\b/i.test(lower)) {
      return "TASK_EXECUTION";
    }

    // Default to general Chat / Reasoning
    return "CHAT_REASONING";
  }

  /**
   * Determines if the input is a revision of a previous turn.
   */
  detectRevision(text) {
    const revisionMarkers = [
      /\b(same\s+(image|photo|picture|result|style))\b/i,
      /\b(isko|usko)\s+(improve|badlo|change|sahi|aur)\b/i,
      /\b(make\s+it\s+(more|less|better|realistic|professional))\b/i,
      /\b(instead\s+of|replace|change\s+to|change\s+the)\b/i,
      /\b(in\s+(evening|morning|night|dawn|sunset)\s+light)\b/i,
      /\b(woman\s+ki|sari|shirt|color|colour)\s+(red|blue|yellow|green|honi|kardo)\b/i,
      /\b(continue\s+from|previous\s+result|pichla)\b/i,
      /\b(add\s+more|remove\s+the|without\s+changing)\b/i,
    ];

    return revisionMarkers.some((regex) => regex.test(text));
  }

  /**
   * Parses natural language constraints, preferences, and negative instructions.
   */
  extractConstraints(text) {
    const negativeConstraints = [];
    const preservedConstraints = [];

    // Negative instructions: "without X", "mat dikhana", "no X", "avoid X"
    const negativePatterns = [
      /(?:without|no|avoid|excluding|free of)\s+([a-zA-Z0-9\s]+?)(?:\.|$|,|\band\b)/gi,
      /([a-zA-Z0-9\s]+?)\s+(?:mat\s+(?:dikhana|karna|rakhna|banao)|nahi\s+hona\s+chahiye)/gi,
      /(?:dont|don't)\s+(?:include|show|add|put)\s+([a-zA-Z0-9\s]+?)(?:\.|$|,|\band\b)/gi,
    ];

    for (const pattern of negativePatterns) {
      let match;
      while ((match = pattern.exec(text)) !== null) {
        let item = match[1].trim().toLowerCase();
        // Remove preservation triggers if caught
        if (item.includes("meaning") || item.includes("original") || item.includes("style")) {
          continue;
        }
        item = item.replace(/\b(and|or|with|also)\b/g, "").trim();
        if (item && !negativeConstraints.includes(item)) {
          negativeConstraints.push(item);
        }
      }
    }

    // Preservation instructions: "original meaning change mat karna", "keep the style"
    if (/original\s+meaning\s+change\s+mat\s+karna/i.test(text) || /keep\s+original\s+meaning/i.test(text)) {
      preservedConstraints.push("PRESERVE_SEMANTIC_MEANING");
    }
    if (/same\s+(?:style|composition|view)/i.test(text) || /style\s+(?:change\s+mat|same\s+rakho)/i.test(text)) {
      preservedConstraints.push("PRESERVE_STYLE_AND_COMPOSITION");
    }

    return { negativeConstraints, preservedConstraints };
  }

  /**
   * Normalizes vernacular Hindi / Hinglish concepts into rich semantic descriptors.
   */
  normalizeVernacularConcepts(text) {
    let normalized = text;

    const vernacularMap = [
      { regex: /\b(village|gaon|gaav)\b/gi, replacement: "rural Indian village with mud houses and rustic courtyards" },
      { regex: /\bkisan\b/gi, replacement: "Indian farmer with weathered features in traditional attire" },
      { regex: /\b(old\s+man|buddha\s+aadmi|vriddha\s+purush)\b/gi, replacement: "elderly Indian man with silver hair and warm expression" },
      { regex: /\b(old\s+woman|buddhi\s+aurat|vriddha\s+mahila)\b/gi, replacement: "elderly Indian woman with silver hair and kind expression" },
      { regex: /\b(aurat|mahila)\b/gi, replacement: "Indian woman in traditional attire" },
      { regex: /\b(khana\s+bana\s+rahe\s*(?:hain)?|cooking)\b/gi, replacement: "cooking fresh food over a traditional outdoor clay chulha stove" },
      { regex: /\b(bachche\s+(?:khaa|kha)\s+rahe\s*(?:hain)?|children\s+eating)\b/gi, replacement: "village children sitting nearby happily eating food" },
      { regex: /\b(woman\s+ki\s+sari\s+red|sari\s+red\s+honi\s+chahiye|laal\s+sari)\b/gi, replacement: "woman dressed in an elegant vibrant red traditional cotton sari with golden border" },
      { regex: /\b(evening\s+light|shaam\s+ka\s+samay|sunset)\b/gi, replacement: "warm golden hour evening sunset lighting with soft dramatic shadows" },
      { regex: /\b(realistic|asali|real)\b/gi, replacement: "photorealistic cinematic National Geographic style photography, 8k resolution, highly detailed" },
      { regex: /\b(titli)\b/gi, replacement: "vibrant butterfly with detailed wings" },
      { regex: /\b(phool)\b/gi, replacement: "fresh blooming flowers with delicate petals" },
      { regex: /\b(paani|pani)\b/gi, replacement: "crystal clear transparent water with realistic refractions" },
      { regex: /\b(seb)\b/gi, replacement: "fresh crisp red apple with natural textures" },
    ];

    for (const item of vernacularMap) {
      normalized = normalized.replace(item.regex, item.replacement);
    }

    return normalized;
  }

  /**
   * Processes a turn in a conversation, maintaining multi-turn context and constraints.
   */
  processTurn(sessionId, userInput, options = {}) {
    const rawText = (userInput || "").trim();
    const lang = this.detectLanguage(rawText);
    const intent = options.forcedIntent || this.classifyIntent(rawText);
    const isRevision = this.detectRevision(rawText);
    const { negativeConstraints, preservedConstraints } = this.extractConstraints(rawText);

    const prevContext = this.sessionContext.get(sessionId) || null;

    let basePrompt = rawText;
    let enhancedPrompt = "";
    let effectiveNegatives = [...negativeConstraints];

    if (intent === "IMAGE_GENERATION") {
      if (isRevision && prevContext && prevContext.enhancedPrompt) {
        // Multi-turn revision: merge delta into previous context
        let merged = prevContext.enhancedPrompt;

        // Check for lighting delta
        if (/\b(evening|sunset|shaam|sun\s+setting)\b/i.test(rawText)) {
          merged = merged.replace(/natural\s+daylight|morning\s+sunlight|dawn/gi, "warm golden hour evening sunset lighting");
          if (!merged.includes("golden hour evening")) {
            merged += ", warm golden hour evening sunset lighting with long soft shadows";
          }
        }

        // Check for wardrobe/color delta
        if (/\b(red\s+sari|sari\s+red|laal\s+sari)\b/i.test(rawText)) {
          merged = merged.replace(/traditional\s+attire/gi, "vibrant red traditional sari with golden embroidery");
          if (!merged.includes("vibrant red")) {
            merged += ", the woman is wearing a vibrant red traditional Indian sari";
          }
        }

        // Apply quality upgrades if requested
        if (/\b(more\s+realistic|professional|improve)\b/i.test(rawText)) {
          if (!merged.includes("award winning")) {
            merged += ", professional award-winning photographic clarity, sharp focus, 8k resolution";
          }
        }

        enhancedPrompt = merged;
        basePrompt = `Revision of: "${prevContext.originalPrompt}" -> Modifications: ${rawText}`;
      } else {
        // New generation
        const normalized = this.normalizeVernacularConcepts(rawText);
        
        // Build photographic enhancement
        enhancedPrompt = normalized;
        if (!/\b(photorealistic|photography|cinematic|detailed)\b/i.test(enhancedPrompt)) {
          enhancedPrompt += ", photorealistic cinematic photography, natural lighting, highly detailed, 8k resolution";
        }
      }

      // Append default clean diffusion negative prompt terms
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
    } else {
      // General Chat / Reasoning / Coding / Tasks
      enhancedPrompt = rawText;
    }

    const state = {
      sessionId,
      timestamp: Date.now(),
      originalPrompt: rawText,
      detectedLanguage: lang,
      intent,
      isRevision,
      preservedConstraints,
      negativeConstraints: effectiveNegatives,
      enhancedPrompt,
      basePrompt,
    };

    // Save context for follow-up turns
    this.sessionContext.set(sessionId, state);

    return state;
  }

  /**
   * Clears session context on demand.
   */
  clearSession(sessionId) {
    this.sessionContext.delete(sessionId);
  }
}

export const sharedIntentEngine = new ConversationalIntentEngine();
