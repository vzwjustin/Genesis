/**
 * Unit tests for pre-dispatch validation failures returning HTTP 400.
 *
 * Requirements 1.4: IF any failure prevents successful request processing
 * (format detection failure, translation failure, model resolution failure,
 * request schema violation), THEN THE Proxy SHALL return HTTP 400 with a
 * descriptive error.
 *
 * Error types: translation_invalid_body, validation_failed, unsupported_request, missing_required_field
 */

import { describe, it, expect } from "vitest";
import {
  buildErrorBody,
  errorResponse,
  validationErrorResponse,
  createErrorResult,
  VALIDATION_ERROR_TYPES,
} from "../../open-sse/utils/error.js";

describe("VALIDATION_ERROR_TYPES constants", () => {
  it("exports all required error types", () => {
    expect(VALIDATION_ERROR_TYPES.TRANSLATION_INVALID_BODY).toBe("translation_invalid_body");
    expect(VALIDATION_ERROR_TYPES.VALIDATION_FAILED).toBe("validation_failed");
    expect(VALIDATION_ERROR_TYPES.UNSUPPORTED_REQUEST).toBe("unsupported_request");
    expect(VALIDATION_ERROR_TYPES.MISSING_REQUIRED_FIELD).toBe("missing_required_field");
  });
});

describe("buildErrorBody with custom error types", () => {
  it("uses default type/code when no options provided", () => {
    const result = buildErrorBody(400, "Bad request");
    expect(result.error.type).toBe("invalid_request_error");
    expect(result.error.code).toBe("bad_request");
    expect(result.error.message).toBe("Bad request");
  });

  it("uses custom errorType when provided", () => {
    const result = buildErrorBody(400, "Invalid body", { errorType: "translation_invalid_body" });
    expect(result.error.type).toBe("translation_invalid_body");
    expect(result.error.code).toBe("bad_request"); // code falls through to default
  });

  it("uses custom errorCode when provided", () => {
    const result = buildErrorBody(400, "Missing field", { errorCode: "missing_required_field" });
    expect(result.error.code).toBe("missing_required_field");
  });

  it("uses both custom errorType and errorCode when provided", () => {
    const result = buildErrorBody(400, "Unsupported", {
      errorType: "unsupported_request",
      errorCode: "unsupported_request",
    });
    expect(result.error.type).toBe("unsupported_request");
    expect(result.error.code).toBe("unsupported_request");
    expect(result.error.message).toBe("Unsupported");
  });
});

describe("validationErrorResponse", () => {
  it("returns HTTP 400 with translation_invalid_body type", async () => {
    const response = validationErrorResponse(
      VALIDATION_ERROR_TYPES.TRANSLATION_INVALID_BODY,
      "Invalid JSON body"
    );
    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error.type).toBe("translation_invalid_body");
    expect(body.error.code).toBe("translation_invalid_body");
    expect(body.error.message).toBe("Invalid JSON body");
  });

  it("returns HTTP 400 with missing_required_field type", async () => {
    const response = validationErrorResponse(
      VALIDATION_ERROR_TYPES.MISSING_REQUIRED_FIELD,
      "Missing required field: model"
    );
    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error.type).toBe("missing_required_field");
    expect(body.error.code).toBe("missing_required_field");
    expect(body.error.message).toBe("Missing required field: model");
  });

  it("returns HTTP 400 with validation_failed type", async () => {
    const response = validationErrorResponse(
      VALIDATION_ERROR_TYPES.VALIDATION_FAILED,
      "Failed to resolve model: nonexistent"
    );
    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error.type).toBe("validation_failed");
    expect(body.error.code).toBe("validation_failed");
    expect(body.error.message).toBe("Failed to resolve model: nonexistent");
  });

  it("returns HTTP 400 with unsupported_request type", async () => {
    const response = validationErrorResponse(
      VALIDATION_ERROR_TYPES.UNSUPPORTED_REQUEST,
      "Unsupported provider target format for unknown/model"
    );
    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error.type).toBe("unsupported_request");
    expect(body.error.code).toBe("unsupported_request");
    expect(body.error.message).toBe("Unsupported provider target format for unknown/model");
  });

  it("includes Content-Type application/json header", () => {
    const response = validationErrorResponse(
      VALIDATION_ERROR_TYPES.VALIDATION_FAILED,
      "test"
    );
    expect(response.headers.get("Content-Type")).toBe("application/json");
  });
});

describe("createErrorResult with custom error types", () => {
  it("returns success=false with correct status", () => {
    const result = createErrorResult(400, "Translation failed", undefined, {
      errorType: VALIDATION_ERROR_TYPES.TRANSLATION_INVALID_BODY,
      errorCode: VALIDATION_ERROR_TYPES.TRANSLATION_INVALID_BODY,
    });
    expect(result.success).toBe(false);
    expect(result.status).toBe(400);
    expect(result.error).toBe("Translation failed");
  });

  it("response body includes custom error type", async () => {
    const result = createErrorResult(400, "Missing messages", undefined, {
      errorType: VALIDATION_ERROR_TYPES.MISSING_REQUIRED_FIELD,
      errorCode: VALIDATION_ERROR_TYPES.MISSING_REQUIRED_FIELD,
    });
    const body = await result.response.json();
    expect(body.error.type).toBe("missing_required_field");
    expect(body.error.code).toBe("missing_required_field");
    expect(body.error.message).toBe("Missing messages");
  });

  it("preserves backward compatibility when no options provided", async () => {
    const result = createErrorResult(400, "Generic bad request");
    expect(result.success).toBe(false);
    expect(result.status).toBe(400);
    const body = await result.response.json();
    expect(body.error.type).toBe("invalid_request_error");
    expect(body.error.code).toBe("bad_request");
  });

  it("preserves resetsAtMs when provided", () => {
    const resetsAt = Date.now() + 60000;
    const result = createErrorResult(400, "Error", resetsAt, {
      errorType: VALIDATION_ERROR_TYPES.VALIDATION_FAILED,
    });
    expect(result.resetsAtMs).toBe(resetsAt);
  });
});

describe("errorResponse with options", () => {
  it("passes custom options through to buildErrorBody", async () => {
    const response = errorResponse(400, "Test error", {
      errorType: "unsupported_request",
      errorCode: "unsupported_request",
    });
    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error.type).toBe("unsupported_request");
    expect(body.error.code).toBe("unsupported_request");
  });

  it("works without options (backward compatible)", async () => {
    const response = errorResponse(400, "Simple error");
    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error.type).toBe("invalid_request_error");
    expect(body.error.code).toBe("bad_request");
  });
});
