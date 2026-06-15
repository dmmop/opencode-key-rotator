export class KeyStoreError extends Error {
    code;
    constructor(code, message) {
        super(message);
        this.code = code;
        this.name = "KeyStoreError";
    }
}
//# sourceMappingURL=errors.js.map