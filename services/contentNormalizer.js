/**
 * Normalizes AI-generated code content.
 *
 * Problem: When AI returns code inside a JSON string, it double-escapes
 * newlines as literal "\\n" (two chars: backslash + n). Parsers like
 * JSON.parse() automatically handle this in pure JSON, but when the AI
 * mixes literal \\n with real newlines (partial double-escaping), some
 * \\n sequences survive and cause SyntaxErrors in JS/JSX files.
 *
 * Fix: Always decode ALL literal escape sequences after JSON parsing,
 * protecting intentional escaped sequences inside string literals first.
 */
export function normalizeContent(content) {
    if (!content) return "";

    // Remove BOM if present
    if (content.charCodeAt(0) === 0xfeff) {
        content = content.slice(1);
    }

    // Step 1: Normalize Windows line endings → Unix
    content = content.replace(/\r\n/g, "\n").replace(/\r/g, "\n");

    // Step 2: Always decode literal escape sequences left over from JSON double-encoding.
    // Protect unicode escapes (e.g., \uXXXX) and intentional double-backslashes.
    content = content
        .replace(/\\\\/g, "%%DQUOTE_BACKSLASH%%")       // protect \\
        .replace(/\\u([0-9a-fA-F]{4})/g, "%%UNICODE_$1%%") // protect \uXXXX
        .replace(/\\n/g, "\n")                           // \\n → real newline
        .replace(/\\t/g, "\t")                           // \\t → real tab
        .replace(/\\r/g, "")                             // \\r → discard
        .replace(/%%UNICODE_([0-9a-fA-F]{4})%%/g, "\\u$1") // restore \uXXXX
        .replace(/%%DQUOTE_BACKSLASH%%/g, "\\");         // restore \

    // Remove literal \n left at the end of lines by AI formatting (e.g., };\n)
    content = content.replace(/;\\n$/gm, ";");

    return content;
}
