// Job templates. Each carries a JSON Schema the verifier checks the output against.

export const TASKS = {
  extraction: {
    skill: "extraction",
    title: "Extract a product listing into structured JSON",
    instructions:
      "Read the product description and return a JSON object with the product name, price in USD as a number, at least three key features, and whether it is in stock.",
    input:
      "Just landed!! The AeroBook 14 ultralight laptop - only 1.1kg, 18hr battery, OLED 2.8K screen & a backlit keyboard. Grab it for $1,249 (was $1,499). Ships today, plenty left in our warehouse.",
    schema: {
      type: "object",
      properties: {
        name: { type: "string", minLength: 2 },
        price_usd: { type: "number", minimum: 0 },
        features: { type: "array", items: { type: "string" }, minItems: 3 },
        in_stock: { type: "boolean" },
      },
      required: ["name", "price_usd", "features", "in_stock"],
      additionalProperties: false,
    },
    // Known-good answer, used only if the LLM is unreachable during a live demo.
    fallback: {
      name: "AeroBook 14",
      price_usd: 1249,
      features: ["1.1kg ultralight", "18 hour battery", "2.8K OLED screen", "backlit keyboard"],
      in_stock: true,
    },
  },

  classification: {
    skill: "classification",
    title: "Classify the sentiment of three customer reviews",
    instructions:
      "For each review, return its index (0-based), a sentiment of positive, negative or neutral, and a confidence between 0 and 1.",
    input: [
      "Battery easily lasts a full workday, love it.",
      "Screen started flickering after two weeks. Returning it.",
      "It's a laptop. Does laptop things.",
    ],
    schema: {
      type: "object",
      properties: {
        results: {
          type: "array",
          minItems: 3,
          maxItems: 3,
          items: {
            type: "object",
            properties: {
              review_index: { type: "integer", minimum: 0, maximum: 2 },
              sentiment: { enum: ["positive", "negative", "neutral"] },
              confidence: { type: "number", minimum: 0, maximum: 1 },
            },
            required: ["review_index", "sentiment", "confidence"],
            additionalProperties: false,
          },
        },
      },
      required: ["results"],
      additionalProperties: false,
    },
    fallback: {
      results: [
        { review_index: 0, sentiment: "positive", confidence: 0.95 },
        { review_index: 1, sentiment: "negative", confidence: 0.93 },
        { review_index: 2, sentiment: "neutral", confidence: 0.8 },
      ],
    },
  },
};

/// The part of a task that goes on-chain (no fallback answer).
export function specFor(task) {
  const { skill, title, instructions, input, schema } = task;
  return { skill, title, instructions, input, schema };
}
