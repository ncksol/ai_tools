class JsonNumberLexeme {
  constructor(value) {
    this.value = value;
  }

  toJSON() {
    return { type: 'json-number', value: this.value };
  }
}

export function isJsonNumberLexeme(value) {
  return value instanceof JsonNumberLexeme;
}

export function parseLosslessJson(source) {
  const text = String(source);
  let index = 0;

  function fail(message) {
    throw new SyntaxError(`${message} at position ${index}`);
  }

  function skipWhitespace() {
    while (index < text.length && /\s/.test(text[index])) index += 1;
  }

  function parseValue() {
    skipWhitespace();
    const character = text[index];
    if (character === '{') return parseObject();
    if (character === '[') return parseArray();
    if (character === '"') return parseString();
    if (text.startsWith('true', index)) {
      index += 4;
      return true;
    }
    if (text.startsWith('false', index)) {
      index += 5;
      return false;
    }
    if (text.startsWith('null', index)) {
      index += 4;
      return null;
    }
    const number = text.slice(index).match(/^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/);
    if (number) {
      index += number[0].length;
      return new JsonNumberLexeme(number[0]);
    }
    fail('Invalid JSON value');
  }

  function parseObject() {
    const result = {};
    index += 1;
    skipWhitespace();
    if (text[index] === '}') {
      index += 1;
      return result;
    }
    while (index < text.length) {
      skipWhitespace();
      if (text[index] !== '"') fail('Object key must be a string');
      const key = parseString();
      skipWhitespace();
      if (text[index] !== ':') fail('Expected colon after object key');
      index += 1;
      Object.defineProperty(result, key, {
        value: parseValue(),
        writable: true,
        enumerable: true,
        configurable: true
      });
      skipWhitespace();
      if (text[index] === '}') {
        index += 1;
        return result;
      }
      if (text[index] !== ',') fail('Expected comma between object properties');
      index += 1;
    }
    fail('Unterminated object');
  }

  function parseArray() {
    const result = [];
    index += 1;
    skipWhitespace();
    if (text[index] === ']') {
      index += 1;
      return result;
    }
    while (index < text.length) {
      result.push(parseValue());
      skipWhitespace();
      if (text[index] === ']') {
        index += 1;
        return result;
      }
      if (text[index] !== ',') fail('Expected comma between array items');
      index += 1;
    }
    fail('Unterminated array');
  }

  function parseString() {
    const start = index;
    index += 1;
    while (index < text.length) {
      const character = text[index];
      if (character === '"') {
        index += 1;
        return JSON.parse(text.slice(start, index));
      }
      if (character === '\\') {
        index += 2;
        continue;
      }
      if (character < ' ') fail('Unescaped control character in string');
      index += 1;
    }
    fail('Unterminated string');
  }

  const value = parseValue();
  skipWhitespace();
  if (index !== text.length) fail('Unexpected trailing content');
  return value;
}
