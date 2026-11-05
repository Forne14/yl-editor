/**
 * The wire contract as plain types and constants, with no runtime imports, so a browser client can use it without
 * pulling in zod or the core. The zod request schemas live in `wire.ts`.
 */
/** The header every request must carry. A browser cannot send it cross-origin without passing a CORS preflight. */
export const REQUESTED_WITH_HEADER = "X-Requested-With";
export const REQUESTED_WITH_VALUE = "yl-editor";
export const DEFAULT_BASE = "/api/content";
export const ERROR_STATUS = {
    forbidden: 403,
    not_found: 404,
    conflict: 409,
    validation: 422,
    path: 400,
    state: 409,
    slug: 400,
    bad_request: 400,
    internal: 500,
};
const isObject = (value) => typeof value === "object" && value !== null;
/** True when `value` is an error envelope with a known code. */
export function isErrorEnvelope(value) {
    if (!isObject(value) || !isObject(value.error))
        return false;
    const { code, message, current } = value.error;
    return (typeof code === "string" &&
        Object.hasOwn(ERROR_STATUS, code) &&
        typeof message === "string" &&
        (current === undefined || isObject(current)));
}
//# sourceMappingURL=wire-types.js.map