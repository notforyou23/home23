const fs = require('node:fs');
const path = require('node:path');
const Ajv2020 = require('ajv/dist/2020');

function loadJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function createContractValidator(rootDir) {
  const root = rootDir || process.cwd();
  const ajv = new Ajv2020({
    allErrors: true,
    strict: false,
    allowUnionTypes: true,
  });
  const loadedSchemas = new Map();

  function contractPath(relativePath) {
    return path.join(root, 'contracts', relativePath);
  }

  function loadSchema(relativePath) {
    if (loadedSchemas.has(relativePath)) return loadedSchemas.get(relativePath);
    const schema = loadJson(contractPath(relativePath));
    ajv.addSchema(schema, schema.$id || relativePath);
    loadedSchemas.set(relativePath, schema);
    return schema;
  }

  function validatorFor(entry) {
    const schema = loadSchema(entry.schema);
    if (!entry.definition) {
      const validate = ajv.getSchema(schema.$id || entry.schema) || ajv.compile(schema);
      return validate;
    }
    const ref = `${schema.$id || entry.schema}#/$defs/${entry.definition}`;
    const validate = ajv.getSchema(ref);
    if (!validate) {
      throw new Error(`${entry.id} references missing definition ${entry.definition} in ${entry.schema}`);
    }
    return validate;
  }

  function validateValue(entry, value) {
    const validate = validatorFor(entry);
    const valid = validate(value);
    return {
      valid,
      errors: validate.errors || [],
      errorsText: validate.errors ? ajv.errorsText(validate.errors, { separator: '\n' }) : '',
    };
  }

  function validateFixture(entry) {
    const value = loadJson(contractPath(entry.fixture));
    return validateValue(entry, value);
  }

  return {
    contractPath,
    loadSchema,
    validateFixture,
    validateValue,
  };
}

module.exports = {
  createContractValidator,
  loadJson,
};
