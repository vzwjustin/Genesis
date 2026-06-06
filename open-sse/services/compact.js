/**
 * Shared combo (model combo) handling with fallback support
 */

/**
 * Validate that a model string is an actionable provider/model target.
 * A valid actionable target is a non-empty string that either:
 *   - Contains a "/" (explicit provider/model format), OR
 *   - Is a non-empty plain string (alias or model name that can be resolved downstream)
 *
 * @param {*} model - Value to validate
 * @returns {boolean} True if the model is a valid actionable target
 */
export function isValidComboModelTarget(model) {
  return typeof model === "string" && model.trim().length > 0;
}

/**
 * Get combo models from combos data.
 *
 * A combo match succeeds only when it resolves to a valid actionable provider/model target.
 * If the combo is found but has no valid actionable models, returns null (combo resolution failed).
 * The caller must not treat the combo-name match alone as success.
 *
 * @param {string} modelStr - Model string to check
 * @param {Array|Object} combosData - Array of combos or object with combos
 * @returns {string[]|null} Array of valid models or null if not a combo / combo has no valid targets
 */
export function getComboModelsFromData(modelStr, combosData) {
  // Don't check if it's in provider/model format
  if (modelStr.includes("/")) return null;
  
  // Handle both array and object formats
  const combos = Array.isArray(combosData) ? combosData : (combosData?.combos || []);
  
  const combo = combos.find(c => c.name === modelStr);
  if (!combo || !combo.models || !Array.isArray(combo.models)) return null;

  // Filter to only valid actionable targets — a combo match succeeds only when
  // it resolves to at least one valid actionable provider/model target.
  const validModels = combo.models.filter(isValidComboModelTarget);
  if (validModels.length === 0) return null;

  return validModels;
}

/**
 * Handle combo chat with fallback
 * @param {Object} options
 * @param {Object} options.body - Request body
 * @param {string[]} options.models - Array of model strings to try
 * @param {Function} options.handleSingleModel - Function to handle single model: (body, modelStr) => Promise<Response>
 * @param {Object} options.log - Logger object
 * @returns {Promise<Response>}
 */
export async function handleComboChat({ body, models, handleSingleModel, log }) {
  let lastError = null;

  for (let i = 0; i < models.length; i++) {
    const modelStr = models[i];
    log.info("COMBO", `Trying model ${i + 1}/${models.length}: ${modelStr}`);

    let result;
    try {
      result = await handleSingleModel(body, modelStr);
    } catch (e) {
      lastError = `${modelStr}: ${e.message}`;
      log.warn("COMBO", `Model threw exception, trying next`, { model: modelStr, error: e.message });
      continue;
    }

    // Success or client error - return response
    if (result.ok || result.status < 500) {
      return result;
    }

    // 5xx error - try next model
    lastError = `${modelStr}: ${result.statusText || result.status}`;
    log.warn("COMBO", `Model failed, trying next`, { model: modelStr, status: result.status });
  }

  log.warn("COMBO", "All models failed");
  
  // Return 503 with last error
  return new Response(
    JSON.stringify({ error: lastError || "All combo models unavailable" }),
    { 
      status: 503, 
      headers: { "Content-Type": "application/json" }
    }
  );
}

