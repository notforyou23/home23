import { syncRegistry } from "./index.js";

const result = syncRegistry();
console.log(JSON.stringify(result, null, 2));
