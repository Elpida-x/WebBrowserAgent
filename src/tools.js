// Tool (function) schemas advertised to the model, in OpenAI/DeepSeek format.
export const TOOLS = [
  {
    type: "function",
    function: {
      name: "navigate",
      description:
        "Navigate the current tab to a URL. Use a full URL including https://.",
      parameters: {
        type: "object",
        properties: {
          url: { type: "string", description: "Absolute URL to open." },
        },
        required: ["url"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "search",
      description:
        "Search the web using the user's DEFAULT search engine (whatever the browser is configured to use — Google/Bing/Baidu/etc.). Results load in the current tab. Prefer this over navigating to a specific search engine URL.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "The search query." },
        },
        required: ["query"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "click",
      description: "Click the interactive element with the given index.",
      parameters: {
        type: "object",
        properties: {
          index: { type: "integer", description: "Index from the current element list." },
        },
        required: ["index"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "find_and_click",
      description:
        "Find the visible element whose text matches `text` and click it (or its nearest clickable ancestor). Use this to open a link / file / menu item you can SEE by its label (e.g. a document title) WITHOUT guessing an index — the real clickable element is often a styled <div>/<span> that does not appear in the numbered element list. After calling it, observe the next state: if the page changed it worked; if not, the text was not clickable, so read the page with extract_content.",
      parameters: {
        type: "object",
        properties: {
          text: {
            type: "string",
            description: "The exact visible text/label to find and click.",
          },
        },
        required: ["text"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "input_text",
      description:
        "Type text into an input/textarea/contenteditable element by index. Set submit=true to press Enter afterwards (e.g. to run a search).",
      parameters: {
        type: "object",
        properties: {
          index: { type: "integer", description: "Index of the field." },
          text: { type: "string", description: "Text to type." },
          submit: {
            type: "boolean",
            description: "Press Enter / submit the form after typing.",
          },
        },
        required: ["index", "text"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "scroll",
      description: "Scroll the page to reveal more content.",
      parameters: {
        type: "object",
        properties: {
          direction: { type: "string", enum: ["down", "up"] },
          amount: { type: "integer", description: "Pixels to scroll (optional)." },
        },
        required: ["direction"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "go_back",
      description: "Go back to the previous page in browser history.",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "wait",
      description: "Wait for the page to load or update, then observe again.",
      parameters: {
        type: "object",
        properties: {
          seconds: { type: "number", description: "Seconds to wait (default 2)." },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "extract_content",
      description:
        "Read the visible text content of the current page (returns up to ~6000 chars). Use this to gather information needed to answer the task.",
      parameters: {
        type: "object",
        properties: {
          goal: {
            type: "string",
            description: "What information you are looking for (for your own reference).",
          },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "request_login",
      description:
        "Call this when the CURRENT page requires the user to log in (or solve a CAPTCHA / dismiss a paywall) before the information you need becomes visible. It pauses and asks the USER to handle it, then returns their decision: 'confirmed' (they did it — re-read the page and continue) or 'cancelled' (do NOT use this site again this task). Never type the user's credentials yourself.",
      parameters: {
        type: "object",
        properties: {
          message: {
            type: "string",
            description:
              "Short note telling the user what is needed, e.g. 'This site needs you to log in to view prices'.",
          },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "request_manual_action",
      description:
        "Use when the site BLOCKED your automated action — e.g. you clicked the right element (via click or find_and_click) but the page did not change, indicating the site rejects synthetic clicks / popups. This pops up a dialog asking the USER to perform that one step manually in the browser, then continue. Returns 'done' (user did it — re-read the page) or 'skipped'. Give a precise instruction of exactly what to do.",
      parameters: {
        type: "object",
        properties: {
          instruction: {
            type: "string",
            description:
              "Exactly what the user should do in the browser, e.g. \"请手动点击打开『AcWing笔记』\".",
          },
        },
        required: ["instruction"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "confirm_action",
      description:
        "Ask the user to confirm BEFORE any irreversible or consequential action — submitting a payment/order, sending a message/email, posting, deleting, or any submit the user did not explicitly request. Returns 'confirmed' (proceed) or 'cancelled' (do NOT do it). Only proceed with the irreversible step after 'confirmed'.",
      parameters: {
        type: "object",
        properties: {
          action: {
            type: "string",
            description:
              "A clear description of the irreversible action about to happen, e.g. \"提交订单并支付 ¥8999\".",
          },
        },
        required: ["action"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "done",
      description:
        "Finish the task and return the final result to the user. Call this when the task is complete OR cannot be completed.",
      parameters: {
        type: "object",
        properties: {
          result: {
            type: "string",
            description: "The complete answer / outcome for the user, with concrete details.",
          },
          success: {
            type: "boolean",
            description: "true if the task was accomplished, false otherwise.",
          },
        },
        required: ["result", "success"],
      },
    },
  },
];
