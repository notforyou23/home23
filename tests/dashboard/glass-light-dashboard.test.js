import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';

const HOME23_ROOT = process.cwd();
const read = (relativePath) => fs.readFileSync(path.join(HOME23_ROOT, relativePath), 'utf8');

const html = read('engine/src/dashboard/home23-dashboard.html');
const js = read('engine/src/dashboard/home23-dashboard.js');
const css = read('engine/src/dashboard/home23-dashboard.css');
const chatJs = read('engine/src/dashboard/home23-chat.js');
const chatCss = read('engine/src/dashboard/home23-chat.css');
const settingsHtml = read('engine/src/dashboard/home23-settings.html');
const settingsCss = read('engine/src/dashboard/home23-settings.css');
const settingsJs = read('engine/src/dashboard/home23-settings.js');
const standaloneChatHtml = read('engine/src/dashboard/home23-chat.html');
const vibeGalleryHtml = read('engine/src/dashboard/home23-vibe/gallery.html');
const welcomeHtml = read('engine/src/dashboard/home23-welcome.html');
const spec = read('docs/superpowers/specs/2026-07-09-glass-light-dashboard-integration-design.md');
const jsAst = ts.createSourceFile(
  'home23-dashboard.js',
  js,
  ts.ScriptTarget.Latest,
  true,
  ts.ScriptKind.JS,
);

const VOID_ELEMENTS = new Set([
  'area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input',
  'link', 'meta', 'param', 'source', 'track', 'wbr',
]);

function parseHtmlTree(source) {
  const root = { tag: '#document', attrs: new Map(), children: [], start: 0, end: source.length };
  const stack = [root];
  const tagPattern = /<\/?([a-z][\w:-]*)\b[^>]*>/gi;
  let match;
  while ((match = tagPattern.exec(source))) {
    const rawTag = match[0];
    const tag = match[1].toLowerCase();
    if (rawTag.startsWith('</')) {
      for (let index = stack.length - 1; index > 0; index -= 1) {
        if (stack[index].tag !== tag) continue;
        stack[index].end = tagPattern.lastIndex;
        stack.length = index;
        break;
      }
      continue;
    }

    const attrs = new Map();
    const attrSource = rawTag.slice(tag.length + 1, -1);
    const attrPattern = /([^\s=/>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g;
    let attrMatch;
    while ((attrMatch = attrPattern.exec(attrSource))) {
      attrs.set(attrMatch[1], attrMatch[2] ?? attrMatch[3] ?? attrMatch[4] ?? '');
    }

    const node = {
      tag,
      attrs,
      children: [],
      parent: stack.at(-1),
      start: match.index,
      end: tagPattern.lastIndex,
    };
    stack.at(-1).children.push(node);
    if (!VOID_ELEMENTS.has(tag) && !rawTag.endsWith('/>')) stack.push(node);
  }
  for (const node of stack) node.end = source.length;
  return root;
}

function walk(node) {
  return [node, ...node.children.flatMap(walk)];
}

function hasClass(node, className) {
  return (node.attrs.get('class') || '').split(/\s+/).includes(className);
}

function findById(tree, id) {
  return walk(tree).find((node) => node.attrs.get('id') === id);
}

function findDescendant(node, predicate) {
  return node.children.flatMap(walk).find(predicate);
}

function sourceForNode(source, node) {
  return source.slice(node.start, node.end);
}

function inlineScripts(source) {
  return [...source.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/gi)]
    .map((match) => match[1])
    .filter((script) => script.trim());
}

function functionFragment(source, name) {
  const declaration = new RegExp(`(?:async\\s+)?function\\s+${name}\\b`);
  const start = source.search(declaration);
  assert.notEqual(start, -1, `missing function ${name}`);
  const tail = source.slice(start + 1);
  const next = tail.search(/\n(?:async\s+)?function\s+[A-Za-z_$][\w$]*\b/);
  return source.slice(start, next === -1 ? source.length : start + 1 + next);
}

function functionClosure(source, entryNames) {
  const queue = [...entryNames];
  const seen = new Set();
  const fragments = [];
  while (queue.length) {
    const name = queue.shift();
    if (seen.has(name)) continue;
    seen.add(name);
    const fragment = functionFragment(source, name);
    fragments.push(fragment);
    for (const call of fragment.matchAll(/\b([A-Za-z_$][\w$]*)\s*\(/g)) {
      const calledName = call[1];
      if (seen.has(calledName)) continue;
      if (new RegExp(`(?:async\\s+)?function\\s+${calledName}\\b`).test(source)) queue.push(calledName);
    }
  }
  return fragments.join('\n');
}

function stringArrayConstants(source) {
  return [...source.matchAll(/const\s+([A-Z_$][\w$]*)\s*=\s*(?:new Set\(\s*)?\[([\s\S]*?)\]\s*\)?\s*;/g)]
    .map((match) => ({
      name: match[1],
      values: [...match[2].matchAll(/['"]([^'"]+)['"]/g)].map((value) => value[1]),
    }));
}

function unwrapExpression(node) {
  let current = node;
  while (
    ts.isParenthesizedExpression(current)
    || ts.isAwaitExpression(current)
    || ts.isAsExpression(current)
    || ts.isNonNullExpression(current)
  ) current = current.expression;
  return current;
}

function collectNamedFunctions(sourceFile) {
  const functions = new Map();
  const visit = (node) => {
    if (ts.isFunctionDeclaration(node) && node.name) functions.set(node.name.text, node);
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)) {
      const initializer = node.initializer && unwrapExpression(node.initializer);
      if (initializer && (ts.isArrowFunction(initializer) || ts.isFunctionExpression(initializer))) {
        functions.set(node.name.text, initializer);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return functions;
}

const jsFunctions = collectNamedFunctions(jsAst);

function visitFunctionBody(functionNode, visitor) {
  const root = functionNode.body;
  if (!root) return;
  const visit = (node) => {
    visitor(node);
    if (node !== root && ts.isFunctionLike(node)) return;
    ts.forEachChild(node, visit);
  };
  visit(root);
}

function expressionContains(node, predicate) {
  let matched = false;
  const visit = (child) => {
    if (matched) return;
    if (predicate(child)) {
      matched = true;
      return;
    }
    ts.forEachChild(child, visit);
  };
  visit(node);
  return matched;
}

function isNamedCall(node, name) {
  const expression = ts.isCallExpression(node) ? unwrapExpression(node.expression) : null;
  return expression && ts.isIdentifier(expression) && expression.text === name;
}

function isSetHasCall(node, setName) {
  if (!ts.isCallExpression(node)) return false;
  const expression = unwrapExpression(node.expression);
  return ts.isPropertyAccessExpression(expression)
    && ts.isIdentifier(unwrapExpression(expression.expression))
    && unwrapExpression(expression.expression).text === setName
    && expression.name.text === 'has';
}

function directMembershipSense(expression, setName, predicateSenses) {
  const node = unwrapExpression(expression);
  if (isSetHasCall(node, setName)) return 1;
  if (ts.isCallExpression(node) && ts.isIdentifier(unwrapExpression(node.expression))) {
    return predicateSenses.get(unwrapExpression(node.expression).text) || 0;
  }
  if (ts.isPrefixUnaryExpression(node) && node.operator === ts.SyntaxKind.ExclamationToken) {
    return -directMembershipSense(node.operand, setName, predicateSenses);
  }
  if (ts.isBinaryExpression(node)) {
    const leftSense = directMembershipSense(node.left, setName, predicateSenses);
    const rightSense = directMembershipSense(node.right, setName, predicateSenses);
    if (leftSense) {
      const right = unwrapExpression(node.right);
      if (right.kind === ts.SyntaxKind.FalseKeyword) return -leftSense;
      return leftSense;
    }
    if (rightSense) {
      const left = unwrapExpression(node.left);
      if (left.kind === ts.SyntaxKind.FalseKeyword) return -rightSense;
      return rightSense;
    }
  }
  return 0;
}

function returnedExpressions(functionNode) {
  if (!functionNode.body) return [];
  if (!ts.isBlock(functionNode.body)) return [functionNode.body];
  const expressions = [];
  visitFunctionBody(functionNode, (node) => {
    if (ts.isReturnStatement(node) && node.expression) expressions.push(node.expression);
  });
  return expressions;
}

function membershipPredicateSenses(setName) {
  const senses = new Map();
  let changed = true;
  while (changed) {
    changed = false;
    for (const [name, functionNode] of jsFunctions) {
      if (senses.has(name)) continue;
      const returned = returnedExpressions(functionNode)
        .map((expression) => directMembershipSense(expression, setName, senses))
        .filter(Boolean);
      if (!returned.length || new Set(returned).size !== 1) continue;
      senses.set(name, returned[0]);
      changed = true;
    }
  }
  return senses;
}

function containsOperationalWork(node, setName, predicateSenses) {
  return expressionContains(node, (child) => {
    if (ts.isBinaryExpression(child)
        && child.operatorToken.kind >= ts.SyntaxKind.FirstAssignment
        && child.operatorToken.kind <= ts.SyntaxKind.LastAssignment) return true;
    if (ts.isPrefixUnaryExpression(child) || ts.isPostfixUnaryExpression(child)) {
      if (child.operator === ts.SyntaxKind.PlusPlusToken || child.operator === ts.SyntaxKind.MinusMinusToken) return true;
    }
    if (!ts.isCallExpression(child)) return false;
    if (isSetHasCall(child, setName)) return false;
    if (ts.isIdentifier(unwrapExpression(child.expression)) && predicateSenses.has(unwrapExpression(child.expression).text)) return false;
    const callText = child.expression.getText(jsAst);
    return !callText.startsWith('console.');
  });
}

function isAbrupt(statement) {
  if (ts.isReturnStatement(statement) || ts.isThrowStatement(statement)
      || ts.isContinueStatement(statement) || ts.isBreakStatement(statement)) return true;
  return ts.isBlock(statement) && statement.statements.length > 0 && isAbrupt(statement.statements.at(-1));
}

function hasOperationalWorkAfter(functionNode, position, setName, predicateSenses) {
  let found = false;
  visitFunctionBody(functionNode, (node) => {
    if (node.pos >= position && containsOperationalWork(node, setName, predicateSenses)) found = true;
  });
  return found;
}

function filterUsesMembership(call, setName, predicateSenses) {
  if (!ts.isCallExpression(call)) return false;
  const expression = unwrapExpression(call.expression);
  if (!ts.isPropertyAccessExpression(expression) || !['filter', 'find', 'some', 'every'].includes(expression.name.text)) return false;
  const callback = call.arguments[0] && unwrapExpression(call.arguments[0]);
  if (!callback || (!ts.isArrowFunction(callback) && !ts.isFunctionExpression(callback))) return false;
  const callbackExpressions = ts.isBlock(callback.body) ? returnedExpressions(callback) : [callback.body];
  return callbackExpressions.some((item) => directMembershipSense(item, setName, predicateSenses) === 1)
    && !ts.isExpressionStatement(call.parent);
}

function delegatedFunction(functionNode) {
  if (!functionNode.body || !ts.isBlock(functionNode.body)) return null;
  const statements = [...functionNode.body.statements];
  const last = statements.at(-1);
  if (!last) return null;
  let expression = null;
  if (ts.isReturnStatement(last) && last.expression) expression = unwrapExpression(last.expression);
  if (ts.isExpressionStatement(last)) expression = unwrapExpression(last.expression);
  if (expression && ts.isCallExpression(expression) && ts.isIdentifier(unwrapExpression(expression.expression))) {
    const priorAreDeclarations = statements.slice(0, -1).every((statement) => ts.isVariableStatement(statement));
    if (priorAreDeclarations) return unwrapExpression(expression.expression).text;
  }
  return null;
}

function functionHasCausalMembershipGate(functionName, setName, predicateSenses, seen = new Set()) {
  if (seen.has(functionName)) return false;
  seen.add(functionName);
  const functionNode = jsFunctions.get(functionName);
  assert.ok(functionNode, `missing function ${functionName}`);
  let gated = false;
  visitFunctionBody(functionNode, (node) => {
    if (gated) return;
    if (ts.isIfStatement(node)) {
      const sense = directMembershipSense(node.expression, setName, predicateSenses);
      if (sense === 1 && containsOperationalWork(node.thenStatement, setName, predicateSenses)) gated = true;
      if (sense === -1 && node.elseStatement && containsOperationalWork(node.elseStatement, setName, predicateSenses)) gated = true;
      if (sense === -1 && isAbrupt(node.thenStatement)
          && hasOperationalWorkAfter(functionNode, node.end, setName, predicateSenses)) gated = true;
    }
    if (filterUsesMembership(node, setName, predicateSenses)) gated = true;
  });
  if (gated) return true;
  const delegate = delegatedFunction(functionNode);
  return delegate && jsFunctions.has(delegate)
    ? functionHasCausalMembershipGate(delegate, setName, predicateSenses, seen)
    : false;
}

function localFunctionCalls(node) {
  const names = new Set();
  const visit = (child) => {
    if (ts.isCallExpression(child)) {
      const expression = unwrapExpression(child.expression);
      if (ts.isIdentifier(expression) && jsFunctions.has(expression.text)) names.add(expression.text);
      for (const argument of child.arguments) {
        const callback = unwrapExpression(argument);
        if (ts.isIdentifier(callback) && jsFunctions.has(callback.text)) names.add(callback.text);
      }
    }
    ts.forEachChild(child, visit);
  };
  visit(node);
  return names;
}

function ownLocalFunctionCalls(functionNode) {
  const names = new Set();
  visitFunctionBody(functionNode, (node) => {
    if (!ts.isCallExpression(node)) return;
    const expression = unwrapExpression(node.expression);
    if (ts.isIdentifier(expression) && jsFunctions.has(expression.text)) names.add(expression.text);
  });
  return names;
}

function isNonDocumentQuery(node) {
  if (!ts.isCallExpression(node)) return false;
  const expression = unwrapExpression(node.expression);
  if (!ts.isPropertyAccessExpression(expression)
      || !['querySelector', 'querySelectorAll'].includes(expression.name.text)) return false;
  const owner = unwrapExpression(expression.expression).getText(jsAst);
  return owner !== 'document' && owner !== 'window.document';
}

function queryReturningFunctions() {
  const names = new Set();
  let changed = true;
  while (changed) {
    changed = false;
    for (const [name, functionNode] of jsFunctions) {
      if (names.has(name)) continue;
      const returnsScopedQuery = returnedExpressions(functionNode).some((expression) => expressionContains(expression, (node) => (
        isNonDocumentQuery(node)
        || (ts.isCallExpression(node)
          && ts.isIdentifier(unwrapExpression(node.expression))
          && names.has(unwrapExpression(node.expression).text))
      )));
      if (!returnsScopedQuery) continue;
      names.add(name);
      changed = true;
    }
  }
  return names;
}

const scopedQueryFunctions = queryReturningFunctions();

function initializerIsOverlayScoped(initializer, scopedNames) {
  return expressionContains(initializer, (node) => {
    if (isNonDocumentQuery(node)) return true;
    if (ts.isPropertyAccessExpression(node) && ['target', 'currentTarget'].includes(node.name.text)) return true;
    if (ts.isCallExpression(node)
        && ts.isIdentifier(unwrapExpression(node.expression))
        && scopedQueryFunctions.has(unwrapExpression(node.expression).text)) return true;
    return ts.isIdentifier(node) && scopedNames.has(node.text);
  });
}

function overlayScopedBindings(functionNode, seededNames = new Set()) {
  const declarations = [];
  const visit = (node) => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) declarations.push(node);
    ts.forEachChild(node, visit);
  };
  if (functionNode.body) visit(functionNode.body);

  const scoped = new Set(seededNames);
  let changed = true;
  while (changed) {
    changed = false;
    for (const declaration of declarations) {
      if (scoped.has(declaration.name.text)) continue;
      if (!initializerIsOverlayScoped(declaration.initializer, scoped)) continue;
      scoped.add(declaration.name.text);
      changed = true;
    }
  }
  return scoped;
}

function regionHasOverlayScopedFocus(region, functionNode, seen = new Set(), seededNames = new Set()) {
  const scoped = overlayScopedBindings(functionNode, seededNames);
  let focused = false;
  const localCalls = [];
  const visit = (node) => {
    if (focused) return;
    if (ts.isCallExpression(node)) {
      const expression = unwrapExpression(node.expression);
      if (ts.isPropertyAccessExpression(expression) && expression.name.text === 'focus') {
        const receiver = unwrapExpression(expression.expression);
        if ((ts.isIdentifier(receiver) && scoped.has(receiver.text)) || isNonDocumentQuery(receiver)) {
          focused = true;
          return;
        }
      }
      if (ts.isIdentifier(expression) && jsFunctions.has(expression.text)) {
        localCalls.push({ name: expression.text, arguments: [...node.arguments] });
      }
      for (const argument of node.arguments) {
        const callback = unwrapExpression(argument);
        if (ts.isIdentifier(callback) && jsFunctions.has(callback.text)) {
          localCalls.push({ name: callback.text, arguments: [] });
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(region);
  if (focused) return true;

  for (const call of localCalls) {
    const { name } = call;
    const helper = jsFunctions.get(name);
    const scopedParameters = new Set();
    helper?.parameters.forEach((parameter, index) => {
      if (!ts.isIdentifier(parameter.name) || !call.arguments[index]) return;
      if (initializerIsOverlayScoped(call.arguments[index], scoped)) scopedParameters.add(parameter.name.text);
    });
    const visitKey = `${name}:${[...scopedParameters].sort().join(',')}`;
    if (seen.has(visitKey)) continue;
    seen.add(visitKey);
    if (helper?.body && regionHasOverlayScopedFocus(helper.body, helper, seen, scopedParameters)) return true;
  }
  return false;
}

function hasDirectVisibilityEvidence(node) {
  return expressionContains(node, (child) => {
    if (ts.isStringLiteralLike(child) && child.text === 'aria-hidden') return true;
    if (ts.isPropertyAccessExpression(child) && child.name.text === 'hidden') return true;
    if (ts.isCallExpression(child)) {
      const expression = unwrapExpression(child.expression);
      if (ts.isIdentifier(expression) && expression.text === 'getComputedStyle') return true;
      if (ts.isPropertyAccessExpression(expression)) {
        const text = expression.getText(jsAst);
        if (text.endsWith('.classList.contains') || text.endsWith('.matches')) return true;
      }
    }
    return false;
  });
}

function visibilityPredicateFunctions() {
  const names = new Set();
  let changed = true;
  while (changed) {
    changed = false;
    for (const [name, functionNode] of jsFunctions) {
      if (names.has(name)) continue;
      const isVisibilityPredicate = returnedExpressions(functionNode).some((expression) => (
        hasDirectVisibilityEvidence(expression)
        || expressionContains(expression, (node) => (
          ts.isCallExpression(node)
          && ts.isIdentifier(unwrapExpression(node.expression))
          && names.has(unwrapExpression(node.expression).text)
        ))
      ));
      if (!isVisibilityPredicate) continue;
      names.add(name);
      changed = true;
    }
  }
  return names;
}

const visibilityPredicates = visibilityPredicateFunctions();

function expressionTestsVisibility(expression) {
  return hasDirectVisibilityEvidence(expression)
    || expressionContains(expression, (node) => (
      ts.isCallExpression(node)
      && ts.isIdentifier(unwrapExpression(node.expression))
      && visibilityPredicates.has(unwrapExpression(node.expression).text)
    ));
}

function handlerHasVisibilityControlledFocus(handler, seen = new Set()) {
  if (!handler?.body) return false;
  let causalFocus = false;
  const visit = (node) => {
    if (causalFocus) return;
    if (ts.isIfStatement(node) && expressionTestsVisibility(node.expression)) {
      causalFocus = regionHasOverlayScopedFocus(node.thenStatement, handler)
        || Boolean(node.elseStatement && regionHasOverlayScopedFocus(node.elseStatement, handler));
      if (causalFocus) return;
    }
    ts.forEachChild(node, visit);
  };
  visit(handler.body);
  if (causalFocus) return true;

  for (const name of localFunctionCalls(handler.body)) {
    if (seen.has(name)) continue;
    seen.add(name);
    if (handlerHasVisibilityControlledFocus(jsFunctions.get(name), seen)) return true;
  }
  return false;
}

function resolveFunctionArgument(argument) {
  const node = argument && unwrapExpression(argument);
  if (!node) return null;
  if (ts.isArrowFunction(node) || ts.isFunctionExpression(node)) return node;
  return ts.isIdentifier(node) ? jsFunctions.get(node.text) || null : null;
}

function collectOpenFocusHandlers(functionName, seen = new Set()) {
  if (seen.has(functionName)) return [];
  seen.add(functionName);
  const functionNode = jsFunctions.get(functionName);
  assert.ok(functionNode, `missing function ${functionName}`);
  const handlers = [];
  visitFunctionBody(functionNode, (node) => {
    if (ts.isNewExpression(node)
        && ts.isIdentifier(unwrapExpression(node.expression))
        && unwrapExpression(node.expression).text === 'MutationObserver') {
      const handler = resolveFunctionArgument(node.arguments?.[0]);
      if (handler) handlers.push({ kind: 'visibility', handler });
    }
    if (ts.isCallExpression(node)) {
      const expression = unwrapExpression(node.expression);
      if (!ts.isPropertyAccessExpression(expression) || expression.name.text !== 'addEventListener') return;
      const eventName = node.arguments[0];
      if (!eventName || !ts.isStringLiteralLike(eventName)
          || !/(?:overlay|dialog).*(?:open|show|reveal)/i.test(eventName.text)) return;
      const handler = resolveFunctionArgument(node.arguments[1]);
      if (handler) handlers.push({ kind: 'open-event', handler });
    }
  });
  for (const calledName of ownLocalFunctionCalls(functionNode)) {
    handlers.push(...collectOpenFocusHandlers(calledName, seen));
  }
  return handlers;
}

function setupHasCausalOpenFocus() {
  const handlers = collectOpenFocusHandlers('setupDashboardOverlayAccessibility');
  return handlers.some(({ kind, handler }) => (
    kind === 'visibility'
      ? handlerHasVisibilityControlledFocus(handler)
      : regionHasOverlayScopedFocus(handler.body, handler)
  ));
}

const htmlTree = parseHtmlTree(html);

function fragmentFromId(source, id, nextPattern) {
  const idIndex = source.indexOf(`id="${id}"`);
  assert.notEqual(idIndex, -1, `missing #${id}`);
  const start = source.lastIndexOf('<', idIndex);
  const next = source.indexOf(nextPattern, idIndex + id.length);
  return source.slice(start, next === -1 ? source.length : next);
}

function cssValuePattern(value) {
  const escapedParts = value
    .trim()
    .split(/\s+/)
    .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  return escapedParts.join('\\s*');
}

/**
 * Intentional minimal DOM harness for dashboard runtime contracts. It supports
 * only the selectors exercised here: #id, button/input/textarea/select,
 * [href], [tabindex], [data-sauna-preset], and the sauna tile's exact
 * [data-home-tile-id] selector. It is not a general CSS selector or layout
 * engine; browser QA remains the authority for full DOM/CSS integration.
 */
class RuntimeClassList {
  constructor(initial = []) {
    this.values = new Set(initial);
  }

  add(...values) { values.forEach((value) => this.values.add(value)); }
  remove(...values) { values.forEach((value) => this.values.delete(value)); }
  contains(value) { return this.values.has(value); }
  toggle(value, force) {
    const enabled = force === undefined ? !this.values.has(value) : Boolean(force);
    if (enabled) this.values.add(value);
    else this.values.delete(value);
    return enabled;
  }
}

class RuntimeElement {
  constructor(document, id, { tagName = 'DIV', display = '', classes = [] } = {}) {
    this.ownerDocument = document;
    this.id = id;
    this.tagName = tagName.toUpperCase();
    this.dataset = {};
    this.attributes = new Map();
    this.listeners = new Map();
    this.children = [];
    this.parentElement = null;
    this.hidden = false;
    this.disabled = false;
    this.isConnected = true;
    this.value = '';
    this.textContent = '';
    this.innerHTML = '';
    this.classList = new RuntimeClassList(classes);
    let zIndex = '';
    const style = {
      display,
      visibility: 'visible',
      overflow: '',
      setProperty(name, value) { this[name] = String(value); },
      removeProperty(name) { delete this[name]; },
    };
    Object.defineProperty(style, 'zIndex', {
      enumerable: true,
      get() { return zIndex; },
      set: (value) => {
        zIndex = String(value ?? '');
        this.ownerDocument.styleWrites.push({ element: this.id, property: 'z-index', value: zIndex });
      },
    });
    this.style = style;
  }

  appendChild(child) {
    child.parentElement = this;
    this.children.push(child);
    this.ownerDocument.register(child);
    return child;
  }

  descendants() {
    return this.children.flatMap((child) => [child, ...child.descendants()]);
  }

  setAttribute(name, value) { this.attributes.set(name, String(value)); }
  getAttribute(name) { return this.attributes.has(name) ? this.attributes.get(name) : null; }
  addEventListener(type, handler) {
    if (!this.listeners.has(type)) this.listeners.set(type, []);
    this.listeners.get(type).push(handler);
  }
  dispatch(type, event = {}) {
    const dispatched = {
      key: '',
      shiftKey: false,
      target: this,
      currentTarget: this,
      defaultPrevented: false,
      preventDefault() { this.defaultPrevented = true; },
      stopPropagation() {},
      ...event,
    };
    for (const handler of this.listeners.get(type) || []) handler(dispatched);
    return dispatched;
  }
  focus() { this.ownerDocument.activeElement = this; }
  contains(element) { return element === this || this.descendants().includes(element); }
  getClientRects() {
    return this.hidden || this.style.display === 'none' || this.style.visibility === 'hidden' ? [] : [{}];
  }

  matches(selector) {
    if (selector.startsWith('#')) return this.id === selector.slice(1);
    if (selector.includes('[data-home-sensor-layout="true"]')) return this.dataset.homeSensorLayout === 'true';
    if (selector.includes('[data-sauna-preset]') && this.dataset.saunaPreset !== undefined) return true;
    if (selector.includes('[data-home-tile-id="sauna-control"]')) return this.dataset.homeTileId === 'sauna-control';
    if (selector.includes('[data-home-tile-id]')) return this.dataset.homeTileId !== undefined;
    if (selector.includes('[data-home-sensor-fixed]')) return this.dataset.homeSensorFixed !== undefined;
    if (selector.includes('[role="tab"]')) {
      return this.getAttribute('role') === 'tab' && (!selector.includes('.h23-tab') || this.classList.contains('h23-tab'));
    }
    if (selector.includes('[role="tablist"]')) return this.getAttribute('role') === 'tablist';
    if (selector.includes('[role="tabpanel"]')) {
      return this.getAttribute('role') === 'tabpanel' && (!selector.includes('.h23-panel') || this.classList.contains('h23-panel'));
    }
    if (selector.includes('[href]') && this.attributes.has('href')) return true;
    if (selector.includes('[tabindex]') && this.attributes.has('tabindex')) return this.attributes.get('tabindex') !== '-1';
    const tag = this.tagName.toLowerCase();
    return ['button', 'input', 'textarea', 'select'].some((candidate) => (
      selector.includes(candidate) && tag === candidate
    ));
  }

  querySelectorAll(selector) {
    return this.descendants().filter((element) => element.matches(selector));
  }

  querySelector(selector) {
    return this.querySelectorAll(selector)[0] || null;
  }

  closest(selector) {
    let current = this;
    while (current) {
      if (current.matches(selector)) return current;
      current = current.parentElement;
    }
    return null;
  }

  click() {
    this.dispatch('click');
    this.ownerDocument.dispatch('click', { target: this });
  }
}

class RuntimeDocument {
  constructor() {
    this.elements = new Map();
    this.listeners = new Map();
    this.styleWrites = [];
    this.body = new RuntimeElement(this, 'body', { tagName: 'BODY' });
    this.register(this.body);
    this.activeElement = this.body;
  }

  register(element) {
    if (element?.id) this.elements.set(element.id, element);
    return element;
  }

  createElement(id, options = {}) {
    return this.register(new RuntimeElement(this, id, options));
  }

  getElementById(id) { return this.elements.get(id) || null; }
  querySelector(selector) { return [...this.elements.values()].find((element) => element.matches(selector)) || null; }
  querySelectorAll(selector) { return [...this.elements.values()].filter((element) => element.matches(selector)); }
  addEventListener(type, handler) {
    if (!this.listeners.has(type)) this.listeners.set(type, []);
    this.listeners.get(type).push(handler);
  }

  dispatch(type, event = {}) {
    const dispatched = {
      key: '',
      shiftKey: false,
      defaultPrevented: false,
      preventDefault() { this.defaultPrevented = true; },
      stopPropagation() {},
      ...event,
    };
    for (const handler of this.listeners.get(type) || []) handler(dispatched);
    return dispatched;
  }
}

function createDashboardRuntime() {
  const document = new RuntimeDocument();
  const mutationObservers = [];
  class RuntimeMutationObserver {
    constructor(callback) {
      this.callback = callback;
      this.targets = new Set();
      mutationObservers.push(this);
    }

    observe(target) { this.targets.add(target); }
  }

  const windowListeners = new Map();
  const window = {
    location: { hostname: 'localhost', port: '5002', hash: '' },
    history: { replaceState(_state, _title, hash) { window.location.hash = hash; } },
    addEventListener(type, handler) { windowListeners.set(type, handler); },
    confirm: () => true,
  };
  const context = vm.createContext({
    console,
    document,
    window,
    MutationObserver: RuntimeMutationObserver,
    getComputedStyle: (element) => ({
      display: element?.style?.display || '',
      visibility: element?.style?.visibility || 'visible',
    }),
    requestAnimationFrame: (callback) => callback(),
    setInterval: () => 1,
    clearInterval: () => {},
    setTimeout: () => 1,
    clearTimeout: () => {},
    fetch: async () => new Response('{}', { status: 200 }),
    Response,
    URLSearchParams,
    AbortSignal,
    Intl,
    confirm: () => true,
    alert: () => {},
  });
  const runtimeSource = js.replace(/\ninit\(\);\s*$/, '\n');
  vm.runInContext(runtimeSource, context, { filename: 'home23-dashboard.js' });
  return {
    context,
    document,
    run(expression) { return vm.runInContext(expression, context); },
    flushMutationRecords(targets) {
      const records = targets.map((target) => ({ target, type: 'attributes' }));
      for (const observer of mutationObservers) {
        const observed = records.filter((record) => observer.targets.has(record.target));
        if (observed.length) observer.callback(observed, observer);
      }
    },
  };
}

test('glass dashboard replaces the dark sidebar shell with the complete top navigation', () => {
  assert.match(html, /class="h23-topbar"/);
  assert.doesNotMatch(html, /class="h23-sidebar"/);
  assert.doesNotMatch(html, /class="h23-system-rail"/);

  for (const label of ['Home', 'Agency', 'Briefs', 'Workers', 'Query', 'Brain Map']) {
    assert.match(html, new RegExp(`data-tab-label="${label}"`));
  }
  assert.match(html, /href="\/home23\/chat"[^>]*data-scope-tab="chat"[^>]*data-tab-label="Chat"/);
  assert.match(html, /id="settings-btn"[^>]*data-scope-tab="settings"[^>]*data-tab-label="Settings"/);
  assert.match(html, /id="cosmo23-btn"[^>]*data-scope-tab="cosmo23"[^>]*data-tab-label="cosmo23"/);
  assert.match(html, /id="evobrew-btn"[^>]*data-scope-tab="evobrew"[^>]*data-tab-label="evobrew"/);
});

test('Home uses the approved fixed hero, sensor strip, and chat-first hierarchy', () => {
  assert.match(html, /class="h23-human-hero-copy"/);
  assert.match(html, /class="h23-human-sensor-strip"/);
  assert.match(html, /class="h23-human-main-grid"/);
  assert.match(html, /data-home-sensor-layout="true"/);

  for (const id of ['outside-weather', 'sauna-control', 'pool-screenlogic']) {
    assert.match(html, new RegExp(`data-home-tile-id="${id}"`));
  }
  for (const id of ['chat', 'vibe', 'good-life', 'system-summary']) {
    assert.doesNotMatch(html, new RegExp(`data-home-tile-id="${id}"`));
  }
});

test('Home regions are correctly nested with five sensor cards and Chat first', () => {
  const home = findById(htmlTree, 'human-home');
  assert.ok(home, 'missing #human-home');
  assert.equal(home.children.length, 3, '#human-home must have only hero, sensor strip, and main grid');

  const [hero, sensorStrip, mainGrid] = home.children;
  assert.ok(hasClass(hero, 'h23-human-hero'), 'Home first region must be the Jerry hero');
  assert.ok(hasClass(sensorStrip, 'h23-human-sensor-strip'), 'Home second region must be the sensor strip');
  assert.equal(sensorStrip.attrs.get('data-home-sensor-layout'), 'true');
  assert.ok(hasClass(mainGrid, 'h23-human-main-grid'), 'Home third region must be the Chat-first main grid');

  assert.ok(findDescendant(hero, (node) => hasClass(node, 'h23-human-hero-copy')));
  assert.ok(findDescendant(hero, (node) => node.attrs.get('id') === 'tz1-time'));
  assert.equal(sensorStrip.children.length, 5, 'sensor strip must have Weather, Sauna, Pool, Problems, and Good Life');
  assert.deepEqual(
    sensorStrip.children.slice(0, 3).map((node) => node.attrs.get('data-home-tile-id')),
    ['outside-weather', 'sauna-control', 'pool-screenlogic'],
  );
  assert.equal(sensorStrip.children[3].tag, 'button');
  assert.ok(findDescendant(sensorStrip.children[3], (node) => node.attrs.get('id') === 'human-issues-value'));
  assert.match(sourceForNode(html, sensorStrip.children[3]), /<span>Problems<\/span>/);
  assert.equal(sensorStrip.children[4].tag, 'button');
  assert.ok(findDescendant(sensorStrip.children[4], (node) => node.attrs.get('id') === 'human-goodlife-value'));

  assert.equal(mainGrid.children.length, 2, 'main grid must contain Chat and the Vibe/Briefs side stack');
  assert.ok(findDescendant(mainGrid.children[0], (node) => node.attrs.get('id') === 'chat-slot-tile'), 'Chat must be first');
  assert.ok(findDescendant(mainGrid.children[1], (node) => node.attrs.get('id') === 'home-vibe-image'));
  assert.ok(findDescendant(mainGrid.children[1], (node) => node.attrs.get('id') === 'human-briefs-list'));
});

test('the redesign preserves production chat, operator, COSMO, and Brain Map hooks', () => {
  for (const id of [
    'chat-shared-template', 'chat-slot-tile', 'chat-slot-overlay',
    'chat-attach-btn', 'chat-attach-input', 'chat-conv-panel',
    'problems-overlay', 'goodlife-overlay', 'brain-storage-overlay',
    'home-vibe-detail-modal', 'chat-overlay', 'problem-editor-overlay',
    'cosmo23-frame-wrap', 'brain-map-container',
  ]) assert.match(html, new RegExp(`id="${id}"`));

  for (const fn of [
    'renderProblemsList', 'renderBrainStoragePanel', 'openGoodLifeOperator',
    'setSaunaPreset', 'runHumanSaunaAction', 'showCosmoFrame',
  ]) assert.match(js, new RegExp(`function ${fn}\\b`));

  assert.match(html, /class="h23-cosmo-heading"[\s\S]*?<h2>COSMO 2\.3<\/h2>/);
  for (const page of [html, standaloneChatHtml]) {
    assert.match(page, /id="chat-attach-btn"[^>]*aria-label="Attach image"[^>]*>[\s\S]*?<span class="h23-chat-attach-icon"[^>]*>Attach<\/span>[\s\S]*?<\/button>/i);
    assert.match(page, /<input(?=[^>]*id="chat-attach-input")(?=[^>]*type="file")(?=[^>]*accept="image\/png,image\/jpeg,image\/webp,image\/gif")(?=[^>]*multiple)[^>]*>/i);
    assert.doesNotMatch(page, /(?:&#x1F4CE;|&#128206;|📎)/i);
  }
  const attachmentBindings = functionFragment(chatJs, 'bindInput');
  for (const eventName of ['paste', 'change', 'dragenter', 'dragover', 'dragleave', 'drop']) {
    assert.match(attachmentBindings, new RegExp(`addEventListener\\(['"]${eventName}['"]`));
  }
  assert.match(attachmentBindings, /attachBtn\.addEventListener\(['"]click['"],\s*\(\)\s*=>\s*attachInput\.click\(\)\)/);
});

test('the approved redesign boundary excludes server, settings API, and runtime state', () => {
  const expectedFiles = spec.match(/Expected production changes:\n\n([\s\S]*?)\n\nAvoid unless proven necessary:/)?.[1];
  assert.ok(expectedFiles, 'spec must retain an explicit expected-production-files section');

  for (const forbidden of [
    'engine/src/dashboard/server.js',
    'engine/src/dashboard/home23-settings-api.js',
    'engine/src/dashboard/home23-settings.js',
    'instances/',
    'config/',
    'ecosystem.config.cjs',
  ]) assert.doesNotMatch(expectedFiles, new RegExp(forbidden.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
});

test('Problems exposes a complete invariant list shell without replacing technical editing', () => {
  const problemsOverlay = findById(htmlTree, 'problems-overlay');
  const editorOverlay = findById(htmlTree, 'problem-editor-overlay');
  assert.ok(problemsOverlay);
  assert.ok(editorOverlay);
  const problemsSource = sourceForNode(html, problemsOverlay);
  const editorSource = sourceForNode(html, editorOverlay);

  assert.match(problemsSource, /id="problems-edit-invariants"[^>]*onclick="openProblemEditorList\(\)"[^>]*>\s*Edit invariants/i);
  for (const id of [
    'problem-invariant-list', 'problem-invariant-add', 'problem-editor-form',
    'problem-editor-back', 'problem-editor-done', 'pe-id', 'pe-claim',
    'pe-verifier', 'pe-remediation', 'pe-delete', 'pe-status',
  ]) assert.match(editorSource, new RegExp(`id="${id}"`), `missing invariant editor control #${id}`);
  assert.match(editorSource, /Back to problems/i);
  assert.match(editorSource, />Done</i);

  const runtime = createDashboardRuntime();
  for (const id of [
    'problem-editor-overlay', 'problem-editor-title', 'problem-invariant-list',
    'problem-editor-form', 'pe-id', 'pe-claim', 'pe-verifier',
    'pe-remediation', 'pe-delete', 'pe-status',
  ]) runtime.document.createElement(id, {
    tagName: id.startsWith('pe-') && !['pe-delete', 'pe-status'].includes(id) ? 'INPUT' : 'DIV',
  });
  runtime.context.__invariants = [{
    id: 'sauna-safe',
    claim: 'Sauna is never left heating unattended',
    verifier: { type: 'http_ping', args: { url: '/sauna/status', intervalMin: 5 } },
    remediation: [{ type: 'notify_jtr' }],
  }];
  runtime.run(`
    _liveProblems = { available: true, problems: globalThis.__invariants };
    openProblemEditorList();
  `);
  const list = runtime.document.getElementById('problem-invariant-list').innerHTML;
  assert.match(list, /Sauna is never left heating unattended/);
  assert.match(list, /Check .*sauna\/status/i);
  assert.match(list, /Every 5 min/i);
  assert.match(list, /data-problem-invariant-id="sauna-safe"/);
  assert.match(list, /data-problem-remove="sauna-safe"/);

  runtime.run(`openProblemEditor('sauna-safe')`);
  assert.equal(runtime.document.getElementById('pe-id').value, 'sauna-safe');
  assert.equal(runtime.document.getElementById('pe-claim').value, 'Sauna is never left heating unattended');
  assert.match(runtime.document.getElementById('pe-verifier').value, /http_ping/);
  assert.match(runtime.document.getElementById('pe-remediation').value, /notify_jtr/);

  const editorRuntime = functionClosure(js, [
    'openProblemEditorList', 'renderProblemInvariantList', 'openProblemEditor',
    'saveProblemEdit', 'deleteProblemFromEditor', 'removeProblemInvariant',
  ]);
  assert.match(editorRuntime, /\/api\/live-problems/);
  assert.match(editorRuntime, /method\s*:\s*['"](?:POST|PUT)['"]/);
  assert.match(editorRuntime, /method\s*:\s*['"]DELETE['"]/);
});

test('active Problems, Brain Storage, and invariant paths emit Glass Light classes and tokens', () => {
  const activeHtml = [
    sourceForNode(html, findById(htmlTree, 'problems-overlay')),
    sourceForNode(html, findById(htmlTree, 'brain-storage-overlay')),
    sourceForNode(html, findById(htmlTree, 'problem-editor-overlay')),
  ].join('\n');
  const activeJs = functionClosure(js, [
    'renderProblemsList', 'renderProblemCard', 'recordProblemUserIntervention',
    'saveProblemEdit', 'renderBrainStoragePanel', 'renderProblemInvariantList',
  ]);
  const forbiddenPaint = /#ffb347|#ff6b6b|#30d158|rgba\(0\s*,\s*122\s*,\s*255|(?:color|background)\s*:\s*#fff\b/i;
  assert.doesNotMatch(activeHtml, forbiddenPaint);
  assert.doesNotMatch(activeJs, forbiddenPaint);
  assert.doesNotMatch(activeHtml, /style="[^"]*(?:color|background|border(?:-color)?):/i);

  for (const [selector, token] of [
    ['.h23-problem-card.open', '--h23-amber-aa'],
    ['.h23-problem-card.chronic', '--h23-red-aa'],
    ['.h23-problem-card.resolved', '--h23-green-aa'],
    ['.h23-overlay-message.error', '--h23-red-aa'],
    ['.h23-problem-editor-status.success', '--h23-green-aa'],
    ['.h23-problem-editor-status.error', '--h23-red-aa'],
    ['.h23-brain-storage-number', '--h23-text-heading'],
  ]) {
    const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    assert.match(css, new RegExp(`body\\.h23-dashboard-page ${escaped}[^\\{]*\\{[^}]*color:\\s*var\\(${token}\\)`));
  }
});

test('Home layout persistence is scoped to environmental sensor cards', () => {
  const allowlist = js.match(/const\s+HOME_LAYOUT_MANAGED_SENSOR_IDS\s*=\s*new Set\(\s*\[([\s\S]*?)\]\s*\)/);
  assert.ok(allowlist, 'missing HOME_LAYOUT_MANAGED_SENSOR_IDS Set');
  const managedIds = [...allowlist[1].matchAll(/['"]([^'"]+)['"]/g)]
    .map((match) => match[1])
    .sort();
  assert.deepEqual(managedIds, ['outside-weather', 'pool-screenlogic', 'sauna-control']);

  const predicateSenses = membershipPredicateSenses('HOME_LAYOUT_MANAGED_SENSOR_IDS');
  for (const fn of ['applyHomeTileLayout', 'renderHomeTileInlineControls', 'mutateHomeTileLayout']) {
    assert.ok(
      functionHasCausalMembershipGate(fn, 'HOME_LAYOUT_MANAGED_SENSOR_IDS', predicateSenses),
      `${fn} must causally gate layout work with HOME_LAYOUT_MANAGED_SENSOR_IDS.has(...)`,
    );
  }
});

test('sensor layout always places managed cards before fixed Problems and Good Life cards', () => {
  const runtime = createDashboardRuntime();
  const strip = runtime.document.createElement('sensor-strip');
  strip.dataset.homeSensorLayout = 'true';
  const cards = new Map();
  for (const id of ['outside-weather', 'sauna-control', 'pool-screenlogic']) {
    const card = runtime.document.createElement(`card-${id}`);
    card.dataset.homeTileId = id;
    strip.appendChild(card);
    cards.set(id, card);
  }
  const problems = runtime.document.createElement('human-issues-card', { tagName: 'BUTTON' });
  problems.dataset.homeSensorFixed = 'problems';
  strip.appendChild(problems);
  const goodLife = runtime.document.createElement('human-goodlife-card', { tagName: 'BUTTON' });
  goodLife.dataset.homeSensorFixed = 'good-life';
  strip.appendChild(goodLife);
  runtime.run('renderHomeTileInlineControls = () => {}');
  runtime.context.__layout = {
    layout: [
      { tileId: 'pool-screenlogic', size: 'third' },
      { tileId: 'outside-weather', size: 'half' },
      { tileId: 'sauna-control', size: 'third' },
    ],
    hiddenTiles: [],
  };
  runtime.run('applyHomeTileLayout(globalThis.__layout)');
  assert.deepEqual(
    ['pool-screenlogic', 'outside-weather', 'sauna-control'].map((id) => cards.get(id).style.order),
    ['0', '1', '2'],
  );
  assert.equal(problems.style.order, '3');
  assert.equal(goodLife.style.order, '4');

  const layoutSource = functionFragment(js, 'applyHomeTileLayout');
  assert.match(layoutSource, /data-home-sensor-fixed/);
  assert.ok(layoutSource.indexOf('data-home-sensor-fixed') > layoutSource.indexOf('HOME_LAYOUT_MANAGED_SENSOR_IDS'));
});

test('native dashboard tabs expose and synchronize tablist relationships', () => {
  const primaryTabs = walk(htmlTree).find((node) => hasClass(node, 'h23-tabs-primary'));
  assert.equal(primaryTabs?.attrs.get('role'), 'tablist');
  for (const tabKey of ['home', 'agency', 'briefs', 'workers', 'query', 'brain-map', 'settings', 'cosmo23']) {
    const tab = walk(htmlTree).find((node) => node.attrs.get('data-tab') === tabKey
      || (tabKey === 'settings' && node.attrs.get('id') === 'settings-btn')
      || (tabKey === 'cosmo23' && node.attrs.get('id') === 'cosmo23-btn'));
    assert.equal(tab?.tag, 'button', `${tabKey} must stay a native button`);
    assert.equal(tab?.attrs.get('role'), 'tab', `${tabKey} must expose role=tab`);
    assert.equal(tab?.attrs.get('aria-controls'), tabKey === 'cosmo23' ? 'cosmo23-frame-wrap' : `panel-${tabKey}`);
    assert.ok(['true', 'false'].includes(tab?.attrs.get('aria-selected')));
  }
  const panelLabels = new Map([
    ['panel-home', 'dashboard-tab-home'],
    ['panel-agency', 'dashboard-tab-agency'],
    ['panel-briefs', 'dashboard-tab-briefs'],
    ['panel-workers', 'dashboard-tab-workers'],
    ['panel-query', 'dashboard-tab-query'],
    ['panel-brain-map', 'dashboard-tab-brain-map'],
    ['panel-settings', 'settings-btn'],
  ]);
  for (const [id, labelledBy] of panelLabels) {
    const panel = findById(htmlTree, id);
    assert.equal(panel?.attrs.get('role'), 'tabpanel', `${id} must expose role=tabpanel`);
    assert.equal(panel?.attrs.get('aria-labelledby'), labelledBy);
  }
  const cosmoPanel = findById(htmlTree, 'cosmo23-frame-wrap');
  assert.equal(cosmoPanel?.attrs.get('role'), 'tabpanel');
  assert.equal(cosmoPanel?.attrs.get('aria-labelledby'), 'cosmo23-btn');
  for (const scope of ['chat', 'evobrew']) {
    const link = walk(htmlTree).find((node) => node.attrs.get('data-scope-tab') === scope);
    assert.equal(link?.tag, 'a');
    assert.notEqual(link?.attrs.get('role'), 'tab');
  }

  const runtime = createDashboardRuntime();
  const primaryList = runtime.document.createElement('runtime-primary-tablist');
  primaryList.setAttribute('role', 'tablist');
  const toolList = runtime.document.createElement('runtime-tool-tablist');
  toolList.setAttribute('role', 'tablist');
  const homeTab = runtime.document.createElement('dashboard-tab-home', { tagName: 'BUTTON', classes: ['h23-tab'] });
  homeTab.dataset.tab = 'home';
  homeTab.setAttribute('role', 'tab');
  primaryList.appendChild(homeTab);
  const settingsTab = runtime.document.createElement('settings-btn', { tagName: 'BUTTON', classes: ['h23-tab'] });
  settingsTab.dataset.tab = 'settings';
  settingsTab.setAttribute('role', 'tab');
  toolList.appendChild(settingsTab);
  const homePanel = runtime.document.createElement('panel-home', { classes: ['h23-panel'] });
  homePanel.setAttribute('role', 'tabpanel');
  const settingsPanel = runtime.document.createElement('panel-settings', { classes: ['h23-panel'] });
  settingsPanel.setAttribute('role', 'tabpanel');
  runtime.run(`syncDashboardTabSemantics('settings')`);
  assert.equal(homeTab.getAttribute('aria-selected'), 'false');
  assert.equal(homeTab.getAttribute('tabindex'), '0', 'each tablist must retain a keyboard entry point');
  assert.equal(settingsTab.getAttribute('aria-selected'), 'true');
  assert.equal(settingsTab.getAttribute('tabindex'), '0');
  assert.equal(homePanel.getAttribute('aria-hidden'), 'true');
  assert.equal(settingsPanel.getAttribute('aria-hidden'), 'false');

  const tabRuntime = functionClosure(js, ['setupTabHandlers', 'selectDashboardTab', 'syncDashboardTabSemantics']);
  assert.match(tabRuntime, /syncDashboardTabSemantics/);
  assert.match(functionFragment(js, 'setupCosmoNavigation'), /syncDashboardTabSemantics\(['"]cosmo23['"]\)/);
});

test('each internal tablist stays keyboard reachable and supports roving activation', () => {
  const runtime = createDashboardRuntime();
  const primaryList = runtime.document.createElement('primary-tablist');
  primaryList.setAttribute('role', 'tablist');
  const toolList = runtime.document.createElement('tool-tablist');
  toolList.setAttribute('role', 'tablist');
  const makeTab = (id, tabKey, scopeKey = '') => {
    const tab = runtime.document.createElement(id, { tagName: 'BUTTON', classes: ['h23-tab'] });
    tab.setAttribute('role', 'tab');
    if (tabKey) tab.dataset.tab = tabKey;
    if (scopeKey) tab.dataset.scopeTab = scopeKey;
    return tab;
  };
  const home = primaryList.appendChild(makeTab('dashboard-tab-home', 'home'));
  const brain = primaryList.appendChild(makeTab('dashboard-tab-brain-map', 'brain-map'));
  const settings = toolList.appendChild(makeTab('settings-btn', '', 'settings'));
  const cosmo = toolList.appendChild(makeTab('cosmo23-btn', '', 'cosmo23'));
  for (const id of ['panel-home', 'panel-brain-map', 'panel-settings']) {
    const panel = runtime.document.createElement(id, { classes: ['h23-panel'] });
    panel.setAttribute('role', 'tabpanel');
  }
  runtime.document.createElement('cosmo23-frame-wrap').setAttribute('role', 'tabpanel');

  runtime.run(`syncDashboardTabSemantics('home')`);
  assert.equal(home.getAttribute('tabindex'), '0');
  assert.equal(brain.getAttribute('tabindex'), '-1');
  assert.equal(settings.getAttribute('tabindex'), '0', 'inactive Settings/COSMO tablist needs a keyboard entry point');
  assert.equal(cosmo.getAttribute('tabindex'), '-1');

  const activations = [];
  for (const tab of [home, brain, settings, cosmo]) {
    tab.addEventListener('click', () => activations.push(tab.id));
  }
  runtime.run('setupDashboardTabKeyboardNavigation()');

  const nextEvent = toolList.dispatch('keydown', { key: 'ArrowRight', target: settings });
  assert.equal(nextEvent.defaultPrevented, true);
  assert.equal(runtime.document.activeElement, cosmo);
  assert.equal(activations.at(-1), 'cosmo23-btn');

  primaryList.dispatch('keydown', { key: 'ArrowLeft', target: home });
  assert.equal(runtime.document.activeElement, brain, 'ArrowLeft must wrap within the primary tablist');
  assert.equal(activations.at(-1), 'dashboard-tab-brain-map');

  toolList.dispatch('keydown', { key: 'Home', target: cosmo });
  assert.equal(runtime.document.activeElement, settings);
  toolList.dispatch('keydown', { key: 'End', target: settings });
  assert.equal(runtime.document.activeElement, cosmo);
});

test('runtime initialization bounds dashboard agent discovery and keeps native status current', () => {
  const init = functionFragment(js, 'init');
  assert.ok(init.indexOf('loadAgents()') < init.indexOf('connectEnginePulse()'), 'agent discovery must precede WebSocket connection');
  assert.match(init, /await\s+settleDashboardStartupDependency\(agentDiscoveryPromise\)/);
  assert.ok(init.indexOf('setupTabHandlers()') < init.indexOf('settleDashboardStartupDependency'));
  assert.ok(init.indexOf('connectEnginePulse()') < init.indexOf('loadHumanHomeSurface()'));
  assert.match(init, /setInterval\(updateClocks,\s*1000\)/);

  const pulse = functionFragment(js, '_renderPulseNow');
  assert.match(pulse, /rail\.hidden\s*=\s*false/);
  assert.match(pulse, /classList\.toggle\(['"]alert['"],\s*isOperatorRuntimeAlert/);
  assert.match(pulse, /state\.textContent/);
  assert.match(pulse, /cycle\.textContent/);

  const clocks = functionFragment(js, 'updateClocks');
  assert.match(clocks, /header-local-time/);
  assert.match(clocks, /tz1-time/);
});

test('native Settings routing, sauna presets, hero metadata, and brain coherence use production data', () => {
  const tabSetup = functionClosure(js, ['setupTabHandlers', 'selectDashboardTab']);
  assert.match(tabSetup, /settings-btn/);
  assert.match(tabSetup, /loadSettingsOverview/);
  assert.doesNotMatch(functionFragment(js, 'loadAgents'), /window\.location\.href\s*=\s*['"]\/home23\/settings/);

  const sauna = functionClosure(js, ['renderHumanSauna', 'renderHumanSaunaActions', 'setSaunaPreset']);
  assert.match(sauna, /\[170,\s*180,\s*190\]/);
  assert.match(sauna, /data-target=["']\$\{target\}["']/);
  assert.doesNotMatch(sauna, /data-target=["'](?:150|210)["']/);
  assert.match(sauna, /data-duration=["']180["']/);
  assert.match(sauna, /\?\s*['"]active['"]\s*:/);
  assert.match(sauna, /classList\.toggle\(['"]active['"]/);
  assert.match(sauna, /(?:Heating|isHeating|heating)/);

  const hero = functionClosure(js, ['loadHumanHomeSurface', 'renderJerryVoiceTile']);
  assert.match(hero, /human-jerry-kicker/);
  assert.match(hero, /human-jerry-status/);
  assert.match(hero, /brain nodes/);
  assert.match(hero, /open problem/);
  assert.doesNotMatch(hero, /api\/brain\/storage/);

  const coherence = functionClosure(js, ['brainStorageStatus', 'renderBrainStoragePanel']);
  for (const status of ['in-sync', 'mismatch']) assert.match(coherence, new RegExp(status));
  assert.doesNotMatch(coherence, /\bpending\b/);
  assert.match(coherence, /data\.mismatch\s*===\s*true/);
  assert.match(coherence, /snapshotNodes\s*===\s*memoryNodes/);
  assert.match(coherence, /snapshotEdges\s*===\s*memoryEdges/);
});

test('startup bounds stalled agent discovery and applies late identity without blocking Home', async () => {
  const settleSource = functionFragment(js, 'settleDashboardStartupDependency');
  const settle = vm.runInNewContext(`${settleSource}\nsettleDashboardStartupDependency`, {
    setTimeout,
    clearTimeout,
  });
  assert.equal(await settle(Promise.resolve('ready'), 30), true);
  assert.equal(await settle(new Promise(() => {}), 5), false);

  const runtime = createDashboardRuntime();
  runtime.run(`
    globalThis.runtimeEvents = [];
    updateClocks = () => {};
    setupTabHandlers = () => {};
    setupOrganDrawer = () => {};
    setupHumanHomeSurface = () => {};
    setupResidentHomeSurface = () => {};
    setupWorkersSurface = () => {};
    setupBriefsSurface = () => {};
    setupDashboardOverlayAccessibility = () => {};
    refreshDashboardIdentityUI = () => runtimeEvents.push('identity');
    refreshDashboardScopeUI = () => runtimeEvents.push('scope-ui');
    selectInitialDashboardTabFromHash = () => false;
    startAutoRefresh = () => runtimeEvents.push('polling');
    loadHumanHomeSurface = () => { runtimeEvents.push('home'); return Promise.resolve(); };
    connectEnginePulse = () => runtimeEvents.push('socket');
    settleDashboardStartupDependency = () => Promise.resolve(false);
    loadAgents = () => new Promise((resolve) => {
      globalThis.releaseAgentDiscovery = () => { runtimeEvents.push('agents'); resolve(); };
    });
    loadDashboardScopeRegistry = () => new Promise((resolve) => {
      globalThis.releaseScopeRegistry = () => { runtimeEvents.push('scope-settled'); resolve(); };
    });
  `);

  const initialization = runtime.run('init()');
  await Promise.resolve();
  await initialization;
  const startupEvents = [...runtime.context.runtimeEvents];
  assert.equal(startupEvents.includes('agents'), false, 'stalled roster must still be pending');
  assert.ok(startupEvents.includes('socket'), 'pulse setup must not wait indefinitely for roster data');
  assert.ok(startupEvents.includes('home'), 'Home data must not wait indefinitely for roster data');
  assert.ok(startupEvents.includes('polling'));

  const identityBeforeRoster = startupEvents.filter((event) => event === 'identity').length;
  runtime.run('releaseAgentDiscovery()');
  await Promise.resolve();
  await Promise.resolve();
  const identityAfterRoster = [...runtime.context.runtimeEvents].filter((event) => event === 'identity').length;
  assert.equal(identityAfterRoster, identityBeforeRoster + 1, 'a late roster must refresh visible identity');

  const refreshesBeforeScope = [...runtime.context.runtimeEvents].filter((event) => event === 'scope-ui').length;
  runtime.run('releaseScopeRegistry()');
  await Promise.resolve();
  await Promise.resolve();
  const refreshesAfterScope = [...runtime.context.runtimeEvents].filter((event) => event === 'scope-ui').length;
  assert.equal(refreshesAfterScope, refreshesBeforeScope + 1, 'settled scope data must refresh its UI independently');

  const initSource = functionFragment(js, 'init');
  assert.match(initSource, /settleDashboardStartupDependency\(/);
  assert.match(initSource, /agentDiscoveryPromise\.then\(/);
  const tabSetup = functionClosure(js, ['setupTabHandlers', 'setupCosmoNavigation']);
  assert.match(tabSetup, /cosmo23-btn/);
  assert.match(tabSetup, /addEventListener\(['"]click['"]/);
  assert.doesNotMatch(functionFragment(js, 'loadAgents'), /cosmoBtn\.addEventListener/);
});

test('late agent discovery transfers pulse ownership without duplicate sockets or stale reconnects', async () => {
  const runtime = createDashboardRuntime();
  const sockets = [];
  const reconnectCallbacks = [];

  class PulseSocket {
    static CONNECTING = 0;
    static OPEN = 1;
    static CLOSING = 2;
    static CLOSED = 3;

    constructor(url) {
      this.url = url;
      this.readyState = PulseSocket.CONNECTING;
      this.closed = false;
      sockets.push(this);
    }

    close() {
      this.closed = true;
      this.readyState = PulseSocket.CLOSED;
      this.onclose?.();
    }
  }

  runtime.context.WebSocket = PulseSocket;
  runtime.context.setTimeout = (callback) => {
    reconnectCallbacks.push(callback);
    return reconnectCallbacks.length;
  };
  runtime.context.clearTimeout = (timerId) => {
    reconnectCallbacks[timerId - 1] = null;
  };
  runtime.run(`
    loadVibeTile = () => Promise.resolve();
    primaryAgent = null;
    connectEnginePulse();
  `);

  assert.equal(sockets.length, 1);
  assert.equal(sockets[0].url, 'ws://localhost:5001');
  const staleClose = sockets[0].onclose;

  runtime.context.__lateAgent = {
    name: 'forrest',
    displayName: 'Forrest',
    dashboardPort: 5012,
    enginePort: 5011,
  };
  runtime.run(`
    primaryAgent = globalThis.__lateAgent;
    refreshDashboardAfterLateAgentDiscovery();
  `);
  await Promise.resolve();

  assert.equal(sockets[0].closed, true, 'the provisional default socket must be closed');
  assert.equal(sockets.length, 2);
  assert.equal(sockets[1].url, 'ws://localhost:5011');
  assert.equal(reconnectCallbacks.filter(Boolean).length, 0);

  staleClose();
  assert.equal(reconnectCallbacks.filter(Boolean).length, 0, 'a stale close must not schedule a default-port reconnect');
  runtime.run('connectEnginePulse()');
  assert.equal(sockets.length, 2, 'rechecking the selected agent must not duplicate its live socket');

  const fastRuntime = createDashboardRuntime();
  const fastSockets = [];
  fastRuntime.context.WebSocket = class extends PulseSocket {
    constructor(url) {
      super(url);
      fastSockets.push(this);
    }
  };
  fastRuntime.context.__fastAgent = {
    name: 'forrest',
    displayName: 'Forrest',
    dashboardPort: 5012,
    enginePort: 5011,
  };
  fastRuntime.run(`
    primaryAgent = globalThis.__fastAgent;
    connectEnginePulse();
    connectEnginePulse();
  `);
  assert.equal(fastSockets.length, 1);
  assert.equal(fastSockets[0].url, 'ws://localhost:5011');
});

test('overlay focus, Tab, Escape, and scroll restoration follow actual paint order', () => {
  const runtime = createDashboardRuntime();
  const { document } = runtime;
  document.body.style.overflow = 'auto';

  const overlays = new Map();
  for (const id of [
    'problems-overlay', 'goodlife-overlay', 'brain-storage-overlay',
    'home-vibe-detail-modal', 'chat-overlay', 'problem-editor-overlay',
  ]) {
    const overlay = document.createElement(id, { display: 'none' });
    overlay.setAttribute('aria-hidden', id === 'home-vibe-detail-modal' ? 'true' : 'false');
    overlays.set(id, overlay);
  }
  const brain = overlays.get('brain-storage-overlay');
  const brainFirst = brain.appendChild(document.createElement('brain-first', { tagName: 'BUTTON' }));
  brain.appendChild(document.createElement('brain-last', { tagName: 'BUTTON' }));
  const problems = overlays.get('problems-overlay');
  const problemsFirst = problems.appendChild(document.createElement('problems-first', { tagName: 'BUTTON' }));
  const problemsLast = problems.appendChild(document.createElement('problems-last', { tagName: 'BUTTON' }));
  const brainInvoker = document.createElement('open-brain', { tagName: 'BUTTON' });
  const problemsInvoker = document.createElement('open-problems', { tagName: 'BUTTON' });

  runtime.run('setupDashboardOverlayAccessibility()');
  document.dispatch('click', { target: brainInvoker });
  brain.style.display = 'flex';
  runtime.flushMutationRecords([brain]);
  assert.equal(document.activeElement, brainFirst);
  assert.equal(document.body.style.overflow, 'hidden');

  document.dispatch('click', { target: problemsInvoker });
  problems.style.display = 'flex';
  runtime.flushMutationRecords([problems]);
  assert.equal(document.activeElement, problemsFirst, 'newly painted dialog receives focus');
  assert.equal(brain.style.zIndex, '1000', 'the lower open dialog retains the base overlay layer');
  assert.equal(problems.style.zIndex, '1001', 'the latest painted dialog is visibly above it');

  problemsLast.focus();
  const tabEvent = document.dispatch('keydown', { key: 'Tab', target: problemsLast });
  assert.equal(tabEvent.defaultPrevented, true);
  assert.equal(document.activeElement, problemsFirst, 'Tab wraps within the actual top dialog');

  const firstEscape = document.dispatch('keydown', { key: 'Escape', target: problemsFirst });
  assert.equal(firstEscape.defaultPrevented, true);
  assert.equal(problems.style.display, 'none', 'last-painted Problems dialog closes first');
  assert.equal(brain.style.display, 'flex');
  assert.equal(document.activeElement, problemsInvoker, 'Problems invoker regains focus');
  assert.equal(document.body.style.overflow, 'hidden', 'scroll stays locked while Brain Storage remains open');

  document.dispatch('keydown', { key: 'Escape', target: problemsInvoker });
  assert.equal(brain.style.display, 'none');
  assert.equal(document.activeElement, brainInvoker, 'Brain Storage invoker regains focus');
  assert.equal(document.body.style.overflow, 'auto', 'original overflow is restored after the last dialog closes');

  // Reverse DOM order: Problems appears after Brain Storage in markup, so
  // opening Problems then Brain proves visual z-order follows paint order.
  document.dispatch('click', { target: problemsInvoker });
  problems.style.display = 'flex';
  runtime.flushMutationRecords([problems]);
  document.dispatch('click', { target: brainInvoker });
  brain.style.display = 'flex';
  runtime.flushMutationRecords([brain]);
  assert.equal(problems.style.zIndex, '1000');
  assert.equal(brain.style.zIndex, '1001', 'reverse-order Brain dialog is visually and logically topmost');
  assert.equal(document.activeElement, brainFirst);

  document.dispatch('keydown', { key: 'Escape', target: brainFirst });
  assert.equal(brain.style.display, 'none');
  assert.equal(problems.style.display, 'flex');
  assert.equal(problems.style.zIndex, '1000', 'remaining dialog resets to the base overlay layer');
  assert.equal(document.activeElement, brainInvoker);

  document.dispatch('keydown', { key: 'Escape', target: brainInvoker });
  assert.equal(problems.style.display, 'none');
  assert.equal(document.activeElement, problemsInvoker);
  assert.equal(document.body.style.overflow, 'auto');
});

test('overlay visual-stack normalization is idempotent under observer feedback', () => {
  const runtime = createDashboardRuntime();
  const { document } = runtime;
  const overlays = [];
  for (const id of [
    'problems-overlay', 'goodlife-overlay', 'brain-storage-overlay',
    'home-vibe-detail-modal', 'chat-overlay', 'problem-editor-overlay',
  ]) {
    const overlay = document.createElement(id, { display: 'none' });
    overlay.setAttribute('aria-hidden', id === 'home-vibe-detail-modal' ? 'true' : 'false');
    overlays.push(overlay);
  }
  const brain = document.getElementById('brain-storage-overlay');
  brain.appendChild(document.createElement('brain-feedback-close', { tagName: 'BUTTON' }));

  runtime.run('setupDashboardOverlayAccessibility()');
  document.styleWrites.length = 0;
  brain.style.display = 'flex';
  runtime.flushMutationRecords([brain]);
  assert.deepEqual(document.styleWrites, [
    { element: 'brain-storage-overlay', property: 'z-index', value: '1000' },
  ]);

  document.styleWrites.length = 0;
  runtime.flushMutationRecords([brain]);
  assert.equal(document.styleWrites.length, 0, 'observer feedback performs no redundant z-index writes');

  brain.style.display = 'none';
  runtime.flushMutationRecords([brain]);
  assert.deepEqual(document.styleWrites, [
    { element: 'brain-storage-overlay', property: 'z-index', value: '' },
  ]);
  document.styleWrites.length = 0;
  runtime.flushMutationRecords([brain]);
  assert.equal(document.styleWrites.length, 0, 'cleared hidden overlays remain write-free on feedback');
  assert.ok(overlays.every((overlay) => overlay.style.zIndex === ''));
});

test('Settings overview settles GET sections independently without mutation requests', async () => {
  const runtime = createDashboardRuntime();
  for (const id of [
    'settings-overview-agents', 'settings-overview-feeds',
    'settings-overview-notifications', 'settings-overview-house',
  ]) runtime.document.createElement(id);
  runtime.context.__settingsCalls = [];
  runtime.context.__feederOffline = false;
  runtime.context.__settingsApiFetch = async (url, options = {}) => {
    runtime.context.__settingsCalls.push({ url, options });
    if (url.includes('/settings/feeder')) {
      if (runtime.context.__feederOffline) throw new Error('feeder offline');
      return {
        feeder: {
          enabled: true,
          additionalWatchPaths: ['/Users/jtr/Documents/briefs'],
          compiler: { enabled: true },
        },
        autoWatchPaths: [
          { path: '/Users/jtr/Downloads', label: 'Incoming downloads', source: 'automatic' },
          { path: '/Users/jtr/Documents/shared', source: 'house defaults' },
        ],
      };
    }
    if (url.includes('/settings/agents')) return {
      currentAgent: 'jerry',
      agents: [
        { name: 'jerry', displayName: 'Jerry', status: 'running', model: 'gpt-production' },
        { name: 'forrest', displayName: 'Forrest', status: 'stopped', model: 'local-model' },
      ],
    };
    if (url.includes('/api/notifications')) return { status: 'ok', pending: 2, length: 5, total: 8, items: [] };
    if (url.includes('/settings/vibe')) return { vibe: { autoGenerate: true, rotationIntervalSeconds: 45, galleryLimit: 60 } };
    throw new Error(`unexpected ${url}`);
  };
  runtime.run(`
    apiFetch = globalThis.__settingsApiFetch;
    primaryAgent = { name: 'jerry', displayName: 'Jerry', model: 'production-model' };
  `);

  await runtime.run('loadSettingsOverview()');
  assert.equal(runtime.context.__settingsCalls.length, 4);
  assert.ok(runtime.context.__settingsCalls.every(({ options }) => !options.method || options.method === 'GET'));
  const agentsOverview = runtime.document.getElementById('settings-overview-agents').innerHTML;
  assert.match(agentsOverview, /h23-settings-overview-row/);
  assert.match(agentsOverview, /Jerry/);
  assert.match(agentsOverview, /Forrest/);
  assert.match(agentsOverview, /gpt-production/);
  assert.match(agentsOverview, /running/);
  const feedsOverview = runtime.document.getElementById('settings-overview-feeds').innerHTML;
  assert.match(feedsOverview, /h23-settings-overview-row/);
  assert.match(feedsOverview, /Feeder/);
  assert.match(feedsOverview, /Enabled/);
  assert.match(feedsOverview, /Documents\/briefs/);
  assert.match(feedsOverview, /Downloads/);
  assert.match(feedsOverview, /Incoming downloads/);
  assert.match(feedsOverview, /automatic/);
  assert.match(feedsOverview, /house defaults/);
  assert.doesNotMatch(feedsOverview, /\[object Object\]/);
  const notificationsOverview = runtime.document.getElementById('settings-overview-notifications').innerHTML;
  assert.match(notificationsOverview, /h23-settings-overview-row/);
  assert.match(notificationsOverview, />Pending</);
  assert.match(notificationsOverview, />2</);
  assert.match(notificationsOverview, />Recent</);
  const houseOverview = runtime.document.getElementById('settings-overview-house').innerHTML;
  assert.match(houseOverview, /h23-settings-overview-row/);
  assert.match(houseOverview, /Vibe generation/);
  assert.match(houseOverview, /Automatic/);

  assert.match(css, /body\.h23-dashboard-page \.h23-settings-overview-row\s*\{/);
  assert.match(css, /body\.h23-dashboard-page \.h23-settings-overview-row-value\s*\{[^}]*color:\s*var\(--h23-text-heading\)/);

  runtime.context.__feederOffline = true;
  await runtime.run('loadSettingsOverview()');
  assert.match(runtime.document.getElementById('settings-overview-feeds').innerHTML, /unavailable/i);
  assert.match(runtime.document.getElementById('settings-overview-agents').innerHTML, /Jerry/);
  assert.match(runtime.document.getElementById('settings-overview-notifications').innerHTML, /Pending/);
  assert.match(runtime.document.getElementById('settings-overview-house').innerHTML, /Vibe generation/);
});

test('Home Problems card executes clear, open, chronic, unverifiable, and unavailable severity semantics', () => {
  const runtime = createDashboardRuntime();
  const card = runtime.document.createElement('human-issues-card', { tagName: 'BUTTON' });
  const status = runtime.document.createElement('human-issues-status');
  const value = runtime.document.createElement('human-issues-value');
  const subtitle = runtime.document.createElement('human-issues-subtitle');
  card.appendChild(status);
  card.appendChild(value);
  card.appendChild(subtitle);

  const cases = [
    [{ available: false }, 'unavailable', '--'],
    [{ available: true, snapshot: { counts: { open: 0, chronic: 0, unverifiable: 0 } } }, 'clear', 'Clear'],
    [{ available: true, snapshot: { counts: { open: 2, chronic: 0, unverifiable: 0 } } }, 'open', '2'],
    [{ available: true, snapshot: { counts: { open: 1, chronic: 2, unverifiable: 0 } } }, 'chronic', '3'],
    [{ available: true, snapshot: { counts: { open: 0, chronic: 0, unverifiable: 4 } } }, 'unverifiable', '4'],
  ];
  for (const [payload, severity, expectedValue] of cases) {
    runtime.context.__issuesPayload = payload;
    runtime.run('renderHumanIssues(globalThis.__issuesPayload)');
    assert.equal(card.dataset.problemSeverity, severity);
    assert.equal(status.textContent, severity);
    assert.equal(value.textContent, expectedValue);
    assert.match(card.getAttribute('aria-label'), new RegExp(`Problems: ${severity}`, 'i'));
  }

  assert.doesNotMatch(css, /h23-human-card-button:first-of-type\s+\.h23-human-value/);
  for (const [severity, token] of [
    ['clear', '--h23-green-aa'],
    ['open', '--h23-amber-aa'],
    ['chronic', '--h23-red-aa'],
    ['unverifiable', '--h23-text-secondary'],
  ]) {
    assert.match(css, new RegExp(`data-problem-severity=["']${severity}["'][\\s\\S]{0,500}var\\(${token}\\)`));
  }
});

test('failed Home Problems requests replace stale clear state with unavailable truth', async () => {
  const runtime = createDashboardRuntime();
  const card = runtime.document.createElement('human-issues-card', { tagName: 'BUTTON' });
  const status = runtime.document.createElement('human-issues-status');
  const value = runtime.document.createElement('human-issues-value');
  const subtitle = runtime.document.createElement('human-issues-subtitle');
  card.appendChild(status);
  card.appendChild(value);
  card.appendChild(subtitle);

  runtime.context.__issuesPayload = {
    available: true,
    snapshot: { counts: { open: 0, chronic: 0, unverifiable: 0 } },
  };
  runtime.run('renderHumanIssues(globalThis.__issuesPayload)');
  assert.equal(card.dataset.problemSeverity, 'clear');

  for (const requestSource of [
    'Promise.resolve(null)',
    "Promise.reject(new Error('request timed out'))",
  ]) {
    runtime.run('renderHumanIssues(globalThis.__issuesPayload)');
    await runtime.run(`(async () => {
      const tasks = [];
      const problemsRequest = ${requestSource}
        .then((data) => data || { available: false })
        .catch(() => ({ available: false }));
      scheduleHumanHomeFetch(tasks, problemsRequest, (data) => renderHumanIssues(data));
      await Promise.all(tasks);
    })()`);
    assert.equal(card.dataset.problemSeverity, 'unavailable');
    assert.equal(status.textContent, 'unavailable');
    assert.equal(value.textContent, '--');
  }

  const loader = functionFragment(js, 'loadHumanHomeSurface');
  assert.match(loader, /api\/live-problems[\s\S]{0,700}latest\.problems\s*=\s*\{ available: false \}/);
  assert.match(loader, /api\/live-problems[\s\S]{0,900}renderHumanIssues\(latest\.problems\)/);
  const scheduler = functionFragment(js, 'scheduleHumanHomeFetch');
  assert.match(scheduler, /data !== null && data !== undefined/);
  assert.match(scheduler, /else if \(onError\) onError/);
});

test('all six Home feeds fail closed while successful siblings render independently', async () => {
  const runtime = createDashboardRuntime();
  for (const id of [
    'human-weather-status', 'human-weather-value', 'human-weather-subtitle', 'human-weather-metrics',
    'human-sauna-status', 'human-sauna-value', 'human-sauna-subtitle', 'human-sauna-metrics', 'human-sauna-actions',
    'human-pool-status', 'human-pool-value', 'human-pool-subtitle', 'human-pool-metrics',
    'human-issues-status', 'human-issues-value', 'human-issues-subtitle',
    'human-goodlife-status', 'human-goodlife-value', 'human-goodlife-subtitle',
    'human-briefs-status', 'human-briefs-list',
  ]) runtime.document.createElement(id);
  runtime.document.createElement('human-issues-card', { tagName: 'BUTTON' });
  const saunaCard = runtime.document.createElement('sauna-card');
  saunaCard.dataset.homeTileId = 'sauna-control';
  const target = runtime.document.createElement('human-sauna-target', { tagName: 'INPUT' });
  target.value = '190';
  const duration = runtime.document.createElement('human-sauna-duration', { tagName: 'INPUT' });
  duration.value = '180';

  runtime.context.__homeFetchMode = 'offline';
  runtime.context.__homeApiFetch = (url) => {
    if (/outside-weather|sauna-control|pool-screenlogic|live-problems|good-life|briefs/.test(url)) {
      return runtime.context.__homeFetchMode === 'offline'
        ? Promise.resolve(null)
        : runtime.context.__homeFetchMode === 'slow-weather' && url.includes('outside-weather')
          ? runtime.context.__weatherPromise
          : url.includes('good-life')
            ? Promise.resolve({ state: { policy: { mode: 'balanced' }, lanes: {} } })
            : Promise.resolve(null);
    }
    return Promise.resolve({});
  };
  runtime.run(`
    primaryAgent = null;
    apiFetch = globalThis.__homeApiFetch;
  `);

  await runtime.run('loadHumanHomeSurface()');
  for (const [id, expected] of [
    ['human-weather-status', 'Offline'],
    ['human-sauna-status', 'Offline'],
    ['human-pool-status', 'Offline'],
    ['human-issues-status', 'unavailable'],
    ['human-goodlife-status', 'unavailable'],
    ['human-briefs-status', 'offline'],
  ]) assert.equal(runtime.document.getElementById(id).textContent, expected, `${id} retained stale/checking truth`);
  assert.match(runtime.document.getElementById('human-sauna-actions').innerHTML, /unavailable/i);
  assert.match(runtime.document.getElementById('human-briefs-list').innerHTML, /unavailable/i);

  let releaseWeather;
  runtime.context.__weatherPromise = new Promise((resolve) => { releaseWeather = resolve; });
  runtime.context.__homeFetchMode = 'slow-weather';
  const secondLoad = runtime.run('loadHumanHomeSurface()');
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(
    runtime.document.getElementById('human-goodlife-value').textContent,
    'BALANCED',
    'a slow Weather feed must not block a successful Good Life sibling',
  );
  releaseWeather({ content: { status: 'Fresh', value: '72°F', subtitle: 'Clear', metrics: [] } });
  await secondLoad;
  assert.equal(runtime.document.getElementById('human-weather-value').textContent, '72°F');

  const loader = functionFragment(js, 'loadHumanHomeSurface');
  for (const feed of ['outside-weather', 'sauna-control', 'pool-screenlogic', 'live-problems', 'good-life', 'briefs']) {
    assert.match(loader, new RegExp(`${feed}[\\s\\S]{0,900}(?:offlineTilePayload|renderHumanIssues|renderHumanGoodLife|Briefs unavailable)`));
  }
});

test('Good Life state:null payload fails closed instead of reporting steady', () => {
  const runtime = createDashboardRuntime();
  for (const id of [
    'human-goodlife-status', 'human-goodlife-value', 'human-goodlife-subtitle',
  ]) runtime.document.createElement(id);

  runtime.context.__goodLifePayload = { state: { policy: { mode: 'balanced' }, lanes: {} } };
  runtime.run('renderHumanGoodLife(globalThis.__goodLifePayload)');
  assert.equal(runtime.document.getElementById('human-goodlife-status').textContent, 'steady');
  assert.equal(runtime.document.getElementById('human-goodlife-value').textContent, 'BALANCED');

  runtime.context.__goodLifePayload = { state: null };
  runtime.run('renderHumanGoodLife(globalThis.__goodLifePayload)');
  assert.equal(runtime.document.getElementById('human-goodlife-status').textContent, 'unavailable');
  assert.equal(runtime.document.getElementById('human-goodlife-value').textContent, '--');
  assert.match(runtime.document.getElementById('human-goodlife-subtitle').textContent, /unavailable/i);
});

test('sauna polling preserves user-edited request state and reflects live heating state', () => {
  const runtime = createDashboardRuntime();
  const target = runtime.document.createElement('human-sauna-target', { tagName: 'INPUT' });
  target.value = '190';
  const duration = runtime.document.createElement('human-sauna-duration', { tagName: 'INPUT' });
  duration.value = '180';
  const actions = runtime.document.createElement('human-sauna-actions');
  const card = runtime.document.createElement('sauna-card');
  card.dataset.homeTileId = 'sauna-control';
  runtime.context.__saunaPayload = {
    content: {
      status: 'Heating',
      value: '145°F',
      subtitle: 'Target 170°F',
      metrics: [
        { label: 'Target', value: '170°F' },
        { label: 'Duration', value: '120 min' },
        { label: 'Heating', value: 'Yes' },
      ],
    },
    actions: [{
      id: 'start',
      label: 'Start',
      fields: [
        { id: 'targetTemperature', defaultValue: 190 },
        { id: 'duration', defaultValue: 180 },
      ],
    }],
  };

  runtime.run('renderHumanSauna(globalThis.__saunaPayload)');
  assert.match(actions.innerHTML, /class="active"[^>]*data-target="170"/);
  assert.equal(card.classList.contains('heating'), true);
  assert.equal(card.classList.contains('running'), true);

  runtime.run('setSaunaPreset(180, 180)');
  runtime.run('renderHumanSauna(globalThis.__saunaPayload)');
  assert.equal(target.value, '180');
  assert.equal(duration.value, '180');
  assert.equal(target.dataset.userEdited, 'true');
  assert.match(actions.innerHTML, /class="active"[^>]*data-target="180"/);
  assert.doesNotMatch(actions.innerHTML, /class="active"[^>]*data-target="170"/);
});

test('Sauna actions are mutually exclusive for idle and running states', () => {
  const runtime = createDashboardRuntime();
  runtime.context.__saunaActions = [
    { id: 'prestage', label: 'Prestage' },
    { id: 'start', label: 'Start' },
    { id: 'stop', label: 'Stop' },
  ];
  const idle = runtime.run('renderHumanSaunaActions(globalThis.__saunaActions, { running: false, heating: false, targetTemperature: 190 })');
  assert.match(idle, /data-sauna-action="prestage"/);
  assert.match(idle, /data-sauna-action="start"/);
  assert.doesNotMatch(idle, /data-sauna-action="stop"/);

  const running = runtime.run('renderHumanSaunaActions(globalThis.__saunaActions, { running: true, heating: true, targetTemperature: 190 })');
  assert.match(running, /data-sauna-action="stop"/);
  assert.doesNotMatch(running, /data-sauna-action="(?:prestage|start)"/);
  assert.match(running, />Heating</);
});

test('Sauna actions render optimistic state before settlement and roll back failed requests', async () => {
  const runtime = createDashboardRuntime();
  for (const id of [
    'human-sauna-status', 'human-sauna-value', 'human-sauna-subtitle',
    'human-sauna-metrics', 'human-sauna-actions', 'human-sauna-gauge',
  ]) runtime.document.createElement(id);
  const card = runtime.document.createElement('sauna-card');
  card.dataset.homeTileId = 'sauna-control';
  const target = runtime.document.createElement('human-sauna-target', { tagName: 'INPUT' });
  target.value = '180';
  target.dataset.userEdited = 'true';
  const duration = runtime.document.createElement('human-sauna-duration', { tagName: 'INPUT' });
  duration.value = '90';
  duration.dataset.userEdited = 'true';
  const button = runtime.document.createElement('sauna-action', { tagName: 'BUTTON' });
  runtime.context.__saunaActions = [
    { id: 'prestage', label: 'Pre-stage' },
    { id: 'start', label: 'Start' },
    { id: 'stop', label: 'Stop' },
  ];
  runtime.context.__idleSauna = {
    content: {
      status: 'Idle',
      value: '72°F',
      subtitle: 'Ready',
      metrics: [
        { label: 'Target', value: '170°F' },
        { label: 'Duration', value: '0 min' },
        { label: 'Heating', value: 'No' },
      ],
    },
    actions: runtime.context.__saunaActions,
  };
  runtime.context.__runningSauna = {
    content: {
      status: 'Heating',
      value: '145°F',
      subtitle: 'Target 180°F',
      metrics: [
        { label: 'Target', value: '180°F' },
        { label: 'Duration', value: '75 min' },
        { label: 'Heating', value: 'Yes' },
      ],
    },
    actions: runtime.context.__saunaActions,
  };
  runtime.context.__saunaCalls = [];
  runtime.run('renderHumanSauna(globalThis.__idleSauna)');

  let rejectStart;
  runtime.context.__saunaRequest = new Promise((_resolve, reject) => { rejectStart = reject; });
  runtime.context.__saunaApiFetch = (url, options) => {
    runtime.context.__saunaCalls.push({ url, options });
    return runtime.context.__saunaRequest;
  };
  runtime.run('apiFetch = globalThis.__saunaApiFetch');
  const startRequest = runtime.run(`runHumanSaunaAction('start', document.getElementById('sauna-action'))`);
  await Promise.resolve();

  assert.equal(card.classList.contains('heating'), true);
  assert.equal(card.classList.contains('running'), true);
  assert.equal(runtime.document.getElementById('human-sauna-status').textContent, 'Heating');
  assert.match(runtime.document.getElementById('human-sauna-actions').innerHTML, /data-sauna-action="stop"/);
  assert.doesNotMatch(runtime.document.getElementById('human-sauna-actions').innerHTML, /data-sauna-action="(?:prestage|start)"/);
  assert.equal(button.disabled, true);
  assert.equal(target.value, '180');
  assert.equal(duration.value, '90');
  assert.equal(runtime.context.__saunaCalls[0].url, '/home23/api/tiles/sauna-control/actions/start');
  assert.deepEqual(JSON.parse(runtime.context.__saunaCalls[0].options.body), {
    targetTemperature: 180,
    duration: 90,
  });

  runtime.run('renderHumanSauna(globalThis.__idleSauna)');
  assert.equal(card.classList.contains('running'), true, 'an independent poll must not erase pending optimistic state');
  rejectStart(new Error('sauna bridge unavailable'));
  await assert.rejects(startRequest, /sauna bridge unavailable/);
  assert.equal(card.classList.contains('heating'), false);
  assert.equal(card.classList.contains('running'), false);
  assert.equal(runtime.document.getElementById('human-sauna-status').textContent, 'action failed');
  assert.match(runtime.document.getElementById('human-sauna-subtitle').textContent, /sauna bridge unavailable/);
  assert.match(runtime.document.getElementById('human-sauna-actions').innerHTML, /data-sauna-action="start"/);
  assert.doesNotMatch(runtime.document.getElementById('human-sauna-actions').innerHTML, /data-sauna-action="stop"/);
  assert.equal(button.disabled, false);

  runtime.run('renderHumanSauna(globalThis.__runningSauna)');
  let resolveStop;
  runtime.context.__saunaRequest = new Promise((resolve) => { resolveStop = resolve; });
  const stopRequest = runtime.run(`runHumanSaunaAction('stop', document.getElementById('sauna-action'))`);
  await Promise.resolve();

  assert.equal(card.classList.contains('heating'), false);
  assert.equal(card.classList.contains('running'), false);
  assert.equal(runtime.document.getElementById('human-sauna-status').textContent, 'Idle');
  assert.match(runtime.document.getElementById('human-sauna-actions').innerHTML, /data-sauna-action="start"/);
  assert.doesNotMatch(runtime.document.getElementById('human-sauna-actions').innerHTML, /data-sauna-action="stop"/);
  assert.equal(runtime.context.__saunaCalls[1].url, '/home23/api/tiles/sauna-control/actions/stop');
  assert.deepEqual(JSON.parse(runtime.context.__saunaCalls[1].options.body), {});

  runtime.run('renderHumanSauna(globalThis.__runningSauna)');
  assert.equal(card.classList.contains('running'), false, 'polling must not erase an optimistic Stop');
  resolveStop({ ok: false, error: 'HUUM rejected stop' });
  await assert.rejects(stopRequest, /HUUM rejected stop/);
  assert.equal(card.classList.contains('heating'), true);
  assert.equal(card.classList.contains('running'), true);
  assert.equal(runtime.document.getElementById('human-sauna-status').textContent, 'action failed');
  assert.match(runtime.document.getElementById('human-sauna-subtitle').textContent, /HUUM rejected stop/);
  assert.match(runtime.document.getElementById('human-sauna-actions').innerHTML, /data-sauna-action="stop"/);
  assert.doesNotMatch(runtime.document.getElementById('human-sauna-actions').innerHTML, /data-sauna-action="(?:prestage|start)"/);
  assert.equal(target.value, '180');
  assert.equal(duration.value, '90');
});

test('successful Sauna actions ignore older polls while later polls remain independent', async () => {
  const runtime = createDashboardRuntime();
  for (const id of [
    'human-sauna-status', 'human-sauna-value', 'human-sauna-subtitle',
    'human-sauna-metrics', 'human-sauna-actions', 'human-sauna-gauge',
  ]) runtime.document.createElement(id);
  const card = runtime.document.createElement('sauna-card');
  card.dataset.homeTileId = 'sauna-control';
  const target = runtime.document.createElement('human-sauna-target', { tagName: 'INPUT' });
  target.value = '180';
  target.dataset.userEdited = 'true';
  const duration = runtime.document.createElement('human-sauna-duration', { tagName: 'INPUT' });
  duration.value = '90';
  duration.dataset.userEdited = 'true';
  const button = runtime.document.createElement('sauna-action', { tagName: 'BUTTON' });
  runtime.context.__saunaActions = [
    { id: 'prestage', label: 'Pre-stage' },
    { id: 'start', label: 'Start' },
    { id: 'stop', label: 'Stop' },
  ];
  runtime.context.__idleSauna = {
    content: {
      status: 'Idle',
      value: '72°F',
      subtitle: 'Ready',
      metrics: [
        { label: 'Target', value: '180°F' },
        { label: 'Duration', value: '0 min' },
        { label: 'Heating', value: 'No' },
      ],
    },
    actions: runtime.context.__saunaActions,
  };
  runtime.context.__runningSauna = {
    content: {
      status: 'Heating',
      value: '145°F',
      subtitle: 'Target 180°F',
      metrics: [
        { label: 'Target', value: '180°F' },
        { label: 'Duration', value: '90 min' },
        { label: 'Heating', value: 'Yes' },
      ],
    },
    actions: runtime.context.__saunaActions,
  };
  runtime.context.__saunaDataRequests = [];
  runtime.context.__saunaActionRequests = [];
  runtime.context.__saunaApiFetch = (url, options = {}) => {
    if (url === '/home23/api/tiles/sauna-control/data') {
      return new Promise((resolve) => runtime.context.__saunaDataRequests.push({ resolve, options }));
    }
    if (url.includes('/home23/api/tiles/sauna-control/actions/')) {
      return new Promise((resolve) => runtime.context.__saunaActionRequests.push({ url, resolve, options }));
    }
    return Promise.resolve(null);
  };
  runtime.run(`
    primaryAgent = null;
    loadVibeTile = () => Promise.resolve();
    apiFetch = globalThis.__saunaApiFetch;
    renderHumanSauna(globalThis.__idleSauna);
  `);

  const preStartPoll = runtime.run('loadHumanHomeSurface()');
  await Promise.resolve();
  assert.equal(runtime.context.__saunaDataRequests.length, 1);
  const startRequest = runtime.run(`runHumanSaunaAction('start', document.getElementById('sauna-action'))`);
  assert.equal(runtime.context.__saunaActionRequests[0].url, '/home23/api/tiles/sauna-control/actions/start');
  assert.deepEqual(JSON.parse(runtime.context.__saunaActionRequests[0].options.body), {
    targetTemperature: 180,
    duration: 90,
  });
  runtime.context.__saunaActionRequests[0].resolve({ ok: true, data: runtime.context.__runningSauna });
  await startRequest;
  assert.equal(card.classList.contains('running'), true);
  assert.equal(runtime.document.getElementById('human-sauna-status').textContent, 'Heating');

  runtime.context.__saunaDataRequests[0].resolve(runtime.context.__idleSauna);
  await preStartPoll;
  assert.equal(card.classList.contains('running'), true, 'a poll started before Start must not replace its successful Heating state');
  assert.equal(runtime.document.getElementById('human-sauna-status').textContent, 'Heating');
  assert.match(runtime.document.getElementById('human-sauna-actions').innerHTML, /data-sauna-action="stop"/);

  const preStopPoll = runtime.run('loadHumanHomeSurface()');
  await Promise.resolve();
  assert.equal(runtime.context.__saunaDataRequests.length, 2);
  const stopRequest = runtime.run(`runHumanSaunaAction('stop', document.getElementById('sauna-action'))`);
  assert.equal(runtime.context.__saunaActionRequests[1].url, '/home23/api/tiles/sauna-control/actions/stop');
  assert.deepEqual(JSON.parse(runtime.context.__saunaActionRequests[1].options.body), {});
  runtime.context.__saunaActionRequests[1].resolve({ ok: true, data: runtime.context.__idleSauna });
  await stopRequest;
  assert.equal(card.classList.contains('running'), false);
  assert.equal(runtime.document.getElementById('human-sauna-status').textContent, 'Idle');

  runtime.context.__saunaDataRequests[1].resolve(runtime.context.__runningSauna);
  await preStopPoll;
  assert.equal(card.classList.contains('running'), false, 'a poll started before Stop must not replace its successful Idle state');
  assert.equal(runtime.document.getElementById('human-sauna-status').textContent, 'Idle');
  assert.match(runtime.document.getElementById('human-sauna-actions').innerHTML, /data-sauna-action="start"/);

  const futurePoll = runtime.run('loadHumanHomeSurface()');
  await Promise.resolve();
  assert.equal(runtime.context.__saunaDataRequests.length, 3);
  runtime.context.__saunaDataRequests[2].resolve(runtime.context.__runningSauna);
  await futurePoll;
  assert.equal(card.classList.contains('running'), true, 'a poll started after the action must still reconcile live state');
  assert.equal(runtime.document.getElementById('human-sauna-status').textContent, 'Heating');
  assert.equal(target.value, '180');
  assert.equal(duration.value, '90');
  assert.equal(button.disabled, false);
});

test('Brain Storage classification and color semantics execute for all states', async () => {
  const runtime = createDashboardRuntime();
  const cases = [
    [{ snapshot: { nodeCount: 10, edgeCount: 20 }, inMemory: { nodes: 10, edges: 20 }, mismatch: false }, 'in-sync', '--h23-green-aa'],
    [{ snapshot: { nodeCount: 10, edgeCount: 20 }, inMemory: { nodes: 12, edges: 22 }, mismatch: true }, 'mismatch', '--h23-red-aa'],
    [{ snapshot: { nodeCount: 10, edgeCount: 20 }, inMemory: { nodes: 10, edges: 20 }, mismatch: true }, 'mismatch', '--h23-red-aa'],
    [{ snapshot: { nodeCount: 10, edgeCount: 20 }, inMemory: { nodes: 9, edges: 22 }, mismatch: false }, 'mismatch', '--h23-red-aa'],
    [{ snapshot: { nodeCount: 10, edgeCount: 20 }, inMemory: null, mismatch: false }, 'unavailable', '--h23-text-secondary'],
  ];
  for (const [data, state, colorToken] of cases) {
    runtime.context.__brainCase = data;
    const presentation = runtime.run('brainStorageStatusPresentation(globalThis.__brainCase)');
    assert.equal(presentation.state, state);
    assert.equal(presentation.color, `var(${colorToken})`);
  }

  const content = runtime.document.createElement('brain-storage-content');
  runtime.context.__brainCase = cases[1][0];
  runtime.context.fetch = async () => ({ ok: true, json: async () => runtime.context.__brainCase });
  await runtime.run('renderBrainStoragePanel()');
  assert.match(content.innerHTML, /h23-brain-storage-status mismatch/);
  assert.match(content.innerHTML, /Investigate before restarting/i);
  assert.match(content.innerHTML, /In memory \(live\)[\s\S]*?12 nodes[\s\S]*?22 edges/i);
  assert.doesNotMatch(content.innerHTML, /Last verified \(engine\)/i);

  for (const [state, token] of [
    ['in-sync', '--h23-green-aa'],
    ['mismatch', '--h23-red-aa'],
    ['unavailable', '--h23-text-secondary'],
  ]) {
    assert.match(css, new RegExp(`h23-brain-storage-status\\.${state}[\\s\\S]*var\\(${token}\\)`));
  }
});

test('dashboard Settings is a read-only overview linked to the full control surface', () => {
  assert.match(html, /id="panel-settings"/);
  assert.match(js, /loadSettingsOverview/);

  const settingsPanel = fragmentFromId(html, 'panel-settings', '<div class="h23-panel"');
  for (const hash of ['agents', 'feeder', 'vibe']) {
    assert.match(settingsPanel, new RegExp(`href="/home23/settings#${hash}"`));
  }
  for (const [id, label] of [
    ['settings-overview-agents-title', 'Agents'],
    ['settings-overview-feeds-title', 'Data Feeds'],
    ['settings-overview-notifications-title', 'Notifications'],
    ['settings-overview-house-title', 'House'],
  ]) assert.match(settingsPanel, new RegExp(`id="${id}"[^>]*>${label}<`));
  assert.doesNotMatch(settingsPanel, />Operations</);
  assert.doesNotMatch(settingsPanel, /<button\b[^>]*>\s*(?:Save|Start|Stop|Delete)\b/i);
});

test('dashboard Settings overview contains no write surface or mutation route', () => {
  const panel = findById(htmlTree, 'panel-settings');
  assert.ok(panel, 'missing #panel-settings');
  const panelSource = sourceForNode(html, panel);

  assert.doesNotMatch(panelSource, /<(?:form|button|input|select|textarea)\b/i);
  assert.doesNotMatch(panelSource, /\bcontenteditable(?:\s*=|\b)/i);
  assert.doesNotMatch(panelSource, /\bon(?:click|change|submit|input)\s*=/i);
  assert.doesNotMatch(panelSource, /\b(?:formaction|action|method)\s*=/i);
  assert.doesNotMatch(panelSource, /\/home23\/api\//i);
  assert.doesNotMatch(panelSource, /\b(?:Save|Start|Stop|Delete|Restart|Install|Build|Connect|Disconnect)\b/i);
  assert.doesNotMatch(
    panelSource,
    /(?:aria-label|title|data-action|name|value)="[^"]*\b(?:save|start|stop|delete|restart|install|build|connect|disconnect)\b[^"]*"/i,
  );

  const links = walk(panel)
    .filter((node) => node.tag === 'a')
    .map((node) => node.attrs.get('href'));
  assert.ok(links.length >= 5, 'overview needs the full Settings link plus section links');
  assert.ok(links.every((href) => /^\/home23\/settings(?:#[a-z-]+)?$/.test(href)), 'all links must stay on full Settings');

  const loader = functionClosure(js, ['loadSettingsOverview']);
  assert.doesNotMatch(loader, /\bmethod\s*:\s*['"](?:POST|PUT|PATCH|DELETE)['"]/i);
  assert.doesNotMatch(loader, /\/(?:save|start|stop|restart|delete|install|build)\b/i);
});

test('COSMO offline treatment uses Glass Light classes without inline dark paint or emoji', () => {
  const offline = functionFragment(js, 'showCosmoOfflineOverlay');
  assert.match(offline, /h23-cosmo-offline-overlay/);
  assert.match(offline, /h23-cosmo-offline-kicker/);
  assert.match(offline, /id="cosmo23-offline-detail"/);
  assert.match(offline, /id="cosmo23-restart-btn"/);
  assert.match(offline, /id="cosmo23-restart-status"/);
  assert.match(offline, /Start COSMO 2\.3/);
  assert.doesNotMatch(offline, /style\.cssText|style="/);
  assert.doesNotMatch(offline, /(?:&#x1F52C;|🔬)/i);

  const restart = functionFragment(js, 'restartCosmo23');
  assert.match(restart, /cosmo23-restart-status/);
  assert.match(restart, /btn\.textContent\s*=\s*'Retry'/);
  assert.match(restart, /\/home23\/api\/settings\/cosmo23\/restart/);
  assert.match(restart, /method:\s*'POST'/);

  assert.match(css, /\.h23-cosmo-offline-overlay\s*\{[\s\S]*?background:\s*var\(--h23-glass-overlay\)/);
  assert.match(css, /\.h23-cosmo-offline-overlay #cosmo23-restart-btn\s*\{[\s\S]*?background:\s*var\(--h23-accent\)/);
});

test('dashboard and Chat UI copy contain no emoji iconography', () => {
  for (const [name, source] of [
    ['dashboard HTML', html],
    ['dashboard JavaScript', js],
    ['standalone Chat HTML', standaloneChatHtml],
    ['Chat JavaScript', chatJs],
  ]) {
    assert.doesNotMatch(source, /\p{Emoji_Presentation}/u, `${name} contains emoji UI copy`);
    assert.doesNotMatch(source, /&#(?:x1F[0-9A-F]+|128\d+);/i, `${name} contains encoded emoji UI copy`);
  }
});

test('all six dashboard overlays expose dialog semantics and unified keyboard lifecycle', () => {
  assert.match(js, /setupDashboardOverlayAccessibility/);
  assert.match(js, /closeTopmostDashboardOverlay/);

  for (const id of [
    'problems-overlay',
    'goodlife-overlay',
    'brain-storage-overlay',
    'home-vibe-detail-modal',
    'chat-overlay',
    'problem-editor-overlay',
  ]) {
    const overlay = fragmentFromId(html, id, '<!--');
    assert.match(overlay, /role="dialog"/, `${id} must expose role="dialog"`);
    assert.match(overlay, /aria-modal="true"/, `${id} must be modal`);
    assert.match(overlay, /aria-labelledby="[^"]+"/, `${id} must have a labelled title`);
  }

  assert.match(css, /@media \(prefers-reduced-motion: reduce\)/);
  assert.match(css, /:focus-visible/);
});

test('overlay dialogs have real dismiss, labelling, focus, Escape, and scroll-lock contracts', () => {
  const overlayIds = [
    'problems-overlay',
    'goodlife-overlay',
    'brain-storage-overlay',
    'home-vibe-detail-modal',
    'chat-overlay',
    'problem-editor-overlay',
  ];

  for (const id of overlayIds) {
    const overlay = findById(htmlTree, id);
    assert.ok(overlay, `missing #${id}`);
    const dialog = findDescendant(overlay, (node) => node.attrs.get('role') === 'dialog')
      || (overlay.attrs.get('role') === 'dialog' ? overlay : null);
    assert.ok(dialog, `${id} needs a dialog owner`);
    assert.equal(dialog.attrs.get('aria-modal'), 'true', `${id} must be modal`);
    const labelledBy = dialog.attrs.get('aria-labelledby');
    assert.ok(labelledBy, `${id} must use aria-labelledby`);
    for (const headingId of labelledBy.split(/\s+/).filter(Boolean)) {
      const heading = findDescendant(dialog, (node) => node.attrs.get('id') === headingId);
      assert.ok(heading, `${id} references #${headingId} outside its dialog subtree`);
      assert.match(heading.tag, /^h[1-6]$/, `${id} label #${headingId} must be a heading`);
    }

    const overlaySource = sourceForNode(html, overlay);
    assert.match(
      overlaySource,
      /<button\b[^>]*(?:(?:aria-label|title)="[^"]*(?:close|dismiss)[^"]*")[^>]*>|<button\b[^>]*>\s*(?:<[^>]+>\s*)*(?:Close|Dismiss)\b/i,
      `${id} needs an accessible dismiss control`,
    );
  }

  const setup = functionClosure(js, ['setupDashboardOverlayAccessibility']);
  const closeTopmost = functionClosure(js, ['closeTopmostDashboardOverlay']);
  const lifecycle = `${setup}\n${closeTopmost}`;
  assert.match(setup, /addEventListener\(\s*['"]keydown['"]/);
  assert.match(setup, /(?:event|e)\.key\s*===\s*['"]Escape['"]/);
  assert.match(setup, /closeTopmostDashboardOverlay\(\)/);
  assert.match(setup, /(?:event|e)\.key\s*===\s*['"]Tab['"]/);
  assert.match(setup, /querySelectorAll\([\s\S]*(?:button|\[href\]|input)/);
  assert.match(setup, /preventDefault\(\)/);
  assert.match(lifecycle, /document\.activeElement/);
  assert.ok((lifecycle.match(/\.focus\(/g) || []).length >= 2, 'lifecycle must enter/trap and restore focus');
  const capturedFocus = lifecycle.match(/(?:const|let|var)?\s*([A-Za-z_$][\w$]*)\s*=\s*document\.activeElement/);
  const mappedFocus = /\.set\([^)]*document\.activeElement[^)]*\)[\s\S]*\.get\([^)]*\)(?:\.|\?\.)focus\(/.test(lifecycle);
  const restoresCapturedFocus = capturedFocus
    && new RegExp(`${capturedFocus[1]}(?:\\.|\\?\\.)focus\\(`).test(lifecycle);
  assert.ok(restoresCapturedFocus || mappedFocus, 'lifecycle must restore the invoking element');

  const directOverlayList = overlayIds.every((id) => closeTopmost.includes(id));
  const referencedOverlayConstant = stringArrayConstants(js).find((candidate) => (
    closeTopmost.includes(candidate.name)
      && candidate.values.length === overlayIds.length
      && candidate.values.every((id) => overlayIds.includes(id))
  ));
  assert.ok(directOverlayList || referencedOverlayConstant, 'topmost close must be limited to the six dashboard overlays');
  assert.match(closeTopmost, /(?:\.at\(\s*-1\s*\)|\.findLast\(|\.reverse\(\)|\[\s*[^\]]+\.length\s*-\s*1\s*\])/);
  assert.match(closeTopmost, /(?:aria-hidden|hidden|getComputedStyle|classList\.contains)/);
  assert.match(closeTopmost, /(?:\.click\(\)|closeProblemsPanel|closeGoodLifeOperator|closeBrainStoragePanel|closeVibeImageDetail)/);

  const inlineScrollLock = /document\.body\.style\.overflow\s*=\s*['"]hidden['"]/.test(js)
    && /document\.body\.style\.overflow\s*=\s*(?:['"]['"]|[A-Za-z_$][\w$]*)/.test(js);
  const classScrollLock = /document\.body\.classList\.(?:add|toggle)\([\s\S]*overlay[\w-]*open/i.test(js)
    && /document\.body\.classList\.(?:remove|toggle)\([\s\S]*overlay[\w-]*open/i.test(js)
    && /body\.[\w-]*overlay[\w-]*open[^\{]*\{[^}]*overflow:\s*hidden/i.test(css);
  assert.ok(inlineScrollLock || classScrollLock, 'overlay lifecycle must lock and restore background scrolling');
});

test('opening or revealing an overlay moves focus inside it before keyboard trapping', () => {
  assert.ok(
    setupHasCausalOpenFocus(),
    'an open/visibility handler must causally focus a target selected inside the opened overlay',
  );
});

test('dashboard installs the approved light-glass tokens and uses them on rendered surfaces', () => {
  const approvedTokens = {
    '--h23-bg': 'linear-gradient(160deg, #EAEEF4 0%, #E4EAF2 40%, #E9EDF0 100%)',
    '--h23-bg-wash-1': 'radial-gradient(900px 480px at 82% -8%, rgba(120, 170, 255, 0.16), transparent 60%)',
    '--h23-bg-wash-2': 'radial-gradient(700px 420px at 4% 108%, rgba(110, 210, 200, 0.13), transparent 60%)',
    '--h23-glass-card': 'rgba(255, 255, 255, 0.58)',
    '--h23-glass-panel': 'rgba(255, 255, 255, 0.62)',
    '--h23-glass-overlay': 'rgba(255, 255, 255, 0.9)',
    '--h23-glass-input': 'rgba(255, 255, 255, 0.85)',
    '--h23-glass-border': 'rgba(255, 255, 255, 0.9)',
    '--h23-glass-blur-card': '20px',
    '--h23-glass-blur-panel': '24px',
    '--h23-glass-blur-overlay': '30px',
    '--h23-shadow-card': '0 8px 32px rgba(30, 45, 70, 0.07)',
    '--h23-shadow-panel': '0 12px 44px rgba(30, 45, 70, 0.09)',
    '--h23-shadow-overlay': '0 32px 90px rgba(20, 30, 50, 0.28)',
    '--h23-shadow-pill': '0 2px 8px rgba(30, 45, 70, 0.08)',
    '--h23-shadow-accent-btn': '0 6px 18px rgba(62, 123, 224, 0.32)',
    '--h23-text-primary': '#1B2028',
    '--h23-text-body': '#333B48',
    '--h23-text-heading': '#232936',
    '--h23-text-secondary': '#5A6474',
    '--h23-text-muted': '#8A93A3',
    '--h23-accent': '#3E7BE0',
    '--h23-accent-tint': 'rgba(62, 123, 224, 0.1)',
    '--h23-accent-tint-border': 'rgba(62, 123, 224, 0.22)',
    '--h23-green': '#1E9E6F',
    '--h23-green-pulse': '#2EB88A',
    '--h23-amber': '#D9762B',
    '--h23-red': '#C94F4F',
    '--h23-text-muted-aa': '#697384',
    '--h23-green-aa': '#177F5B',
    '--h23-amber-aa': '#A9571C',
    '--h23-red-aa': '#B53F3F',
    '--h23-hairline': 'rgba(27, 32, 40, 0.07)',
    '--h23-input-border': 'rgba(27, 32, 40, 0.09)',
    '--h23-hover-row': 'rgba(27, 32, 40, 0.04)',
    '--h23-hover-card': 'rgba(255, 255, 255, 0.78)',
    '--h23-overlay-backdrop': 'rgba(30, 42, 64, 0.32)',
    '--h23-radius-pill': '999px',
    '--h23-radius-input': '14px',
    '--h23-radius-card': '16px',
    '--h23-radius-panel': '20px',
    '--h23-radius-overlay': '24px',
    '--h23-font-ui': "'Instrument Sans', -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif",
    '--h23-font-mono': "'IBM Plex Mono', ui-monospace, monospace",
    '--h23-gutter': '24px',
    '--h23-gap': '16px',
    '--h23-card-pad': '22px 24px',
  };

  for (const [token, value] of Object.entries(approvedTokens)) {
    assert.match(css, new RegExp(`${token}:\\s*${cssValuePattern(value)}\\s*;`, 'i'), `missing ${token}`);
  }

  assert.match(html, /family=Instrument\+Sans:wght@400;500;600;700/);
  assert.match(css, /body\.h23-dashboard-page[\s\S]*background:\s*var\(--h23-bg\)/);
  assert.match(css, /\.h23-human-card[^\{]*\{[^}]*background:\s*var\(--h23-glass-card\)/);
  assert.match(css, /\.h23-topbar[^\{]*\{[^}]*background:\s*var\(--h23-glass-panel\)/);

  const dashboardScopedCss = css.slice(css.indexOf('body.h23-dashboard-page'));
  assert.doesNotMatch(dashboardScopedCss, /background-size:\s*88px 88px/);
  assert.doesNotMatch(dashboardScopedCss, /rgba\(255,\s*255,\s*255,\s*0\.025\) 1px/);
});

test('glass override selectors stay dashboard-scoped while tokens remain shareable', () => {
  const marker = 'Glass Light dashboard system';
  const overrideStart = css.indexOf(marker);
  assert.notEqual(overrideStart, -1, 'missing final Glass Light override layer');
  const overrideCss = css.slice(overrideStart);
  const unscopedSelectors = overrideCss
    .split('\n')
    .filter((line) => /^\s*(?:\.h23|#(?:panel|brain|problem))/.test(line.trimStart()));
  assert.deepEqual(unscopedSelectors, [], `unscoped dashboard selectors:\n${unscopedSelectors.join('\n')}`);
  assert.doesNotMatch(overrideCss, /^\s*:root\s*\{/m, 'responsive dashboard tokens must be body-scoped');
});

test('light operational panels override legacy white renderer text', () => {
  for (const selector of ['#panel-agency', '#panel-workers', '.h23-log-overlay-body']) {
    const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    assert.match(css, new RegExp(`body\\.h23-dashboard-page ${escaped} \\[style\\*="color:#fff"\\]`));
    assert.match(css, new RegExp(`body\\.h23-dashboard-page ${escaped} \\[style\\*="color:rgba\\(255"\\]`));
  }
  const colorContracts = new Map([
    ['.h23-problems-history-row span', '--h23-text-body'],
    ['.h23-problem-evidence-grid span', '--h23-text-secondary'],
    ['.h23-human-brief-row strong', '--h23-text-heading'],
    ['.h23-human-brief-row span:last-child', '--h23-text-secondary'],
    ['.h23-human-brief-meta', '--h23-text-muted-aa'],
    ['.h23-briefs-row-meta', '--h23-text-muted-aa'],
    ['.h23-briefs-reader-meta', '--h23-text-muted-aa'],
    ['.h23-briefs-row strong', '--h23-text-heading'],
    ['.h23-briefs-row span:last-child', '--h23-text-secondary'],
    ['.h23-briefs-reader-head h2', '--h23-text-heading'],
    ['.h23-briefs-document', '--h23-text-body'],
    ['.h23-briefs-provenance', '--h23-text-muted-aa'],
    ['.h23-goodlife-lane', '--h23-text-secondary'],
    ['.h23-goodlife-lane.critical', '--h23-red-aa'],
    ['.h23-goodlife-lane.strained', '--h23-amber-aa'],
    ['.h23-goodlife-lane.watch', '--h23-accent'],
    ['.h23-goodlife-lane.healthy', '--h23-green-aa'],
    ['.h23-goodlife-overlay-status', '--h23-text-secondary'],
    ['.h23-goodlife-evidence-row.info em', '--h23-text-muted-aa'],
    ['.h23-worker-capability-kicker', '--h23-green-aa'],
    ['.h23-worker-status.pass', '--h23-green-aa'],
    ['.h23-worker-status.fail', '--h23-red-aa'],
    ['.h23-worker-status.blocked', '--h23-amber-aa'],
    ['.h23-resident-command p', '--h23-text-body'],
    ['.h23-resident-health', '--h23-text-muted-aa'],
  ]);

  for (const [selector, token] of colorContracts) {
    const escapedSelector = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const escapedToken = token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    assert.match(
      css,
      new RegExp(`body\\.h23-dashboard-page ${escapedSelector}[^\\{]*\\{[^}]*color:\\s*var\\(${escapedToken}\\)`),
      `${selector} must use ${token} on the light operational surface`,
    );
  }

  assert.match(
    css,
    /body\.h23-dashboard-page \.qt-container\s*\{[^}]*--bg-primary:\s*var\(--h23-glass-panel\)[^}]*--text-primary:\s*var\(--h23-text-primary\)/,
    'the dynamically injected Query renderer must inherit explicit light surface tokens',
  );

  for (const panel of ['#panel-workers', '#panel-query', '#panel-brain-map']) {
    const escapedPanel = panel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    assert.match(
      css,
      new RegExp(`body\\.h23-dashboard-page ${escapedPanel}[^\\{]*\\{[^}]*background:\\s*var\\(--h23-glass-panel\\)[^}]*border:\\s*1px solid var\\(--h23-hairline\\)`),
      `${panel} must replace the legacy --surface-2 shell beneath light renderer text`,
    );
  }
});

test('standalone Chat remaps every legacy light-shell alias and control state', () => {
  const standalone = chatCss.match(/body:not\(\.h23-dashboard-page\)\s*\{([^}]+)\}/)?.[1] || '';
  for (const alias of [
    '--glass-primary', '--glass-secondary', '--glass-border',
    '--text-primary', '--text-secondary', '--text-muted',
    '--accent-blue', '--accent-red', '--shadow-glass',
  ]) assert.match(standalone, new RegExp(`${alias}:`), `standalone Chat does not remap ${alias}`);

  for (const selector of [
    '.sh-icon-btn', '.sh-title', '.sh-dashboard-link', '.sh-drawer-title',
    '.sh-field-label', '.sh-sheet-action', '.sh-sheet-grip', '.sh-input',
  ]) {
    const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    assert.match(chatCss, new RegExp(`body:not\\(\\.h23-dashboard-page\\) ${escaped}`), `missing ${selector} light override`);
  }
});

test('related Home23 pages declare isolated light-theme scopes and approved type', () => {
  const pages = [
    [settingsHtml, 'h23-settings-page'],
    [standaloneChatHtml, 'h23-chat-page'],
    [vibeGalleryHtml, 'h23-vibe-page'],
    [welcomeHtml, 'h23-welcome-page'],
  ];

  for (const [page, scope] of pages) {
    assert.match(page, new RegExp(`<body[^>]*class="[^"]*\\b${scope}\\b[^"]*"`), `${scope} body scope is missing`);
    assert.match(page, /family=Instrument\+Sans:wght@400;500;600;700&family=IBM\+Plex\+Mono:wght@400;500;600/);
    assert.doesNotMatch(page, /(?:prototype|support-runtime)\.js/i);
  }

  assert.match(settingsCss, /Glass Light settings surface/);
  assert.match(settingsCss, /body\.h23-settings-page\s*\{/);
  assert.match(standaloneChatHtml, /Glass Light standalone Chat surface/);
  assert.match(vibeGalleryHtml, /Glass Light Vibe gallery surface/);
  assert.match(welcomeHtml, /Glass Light welcome surface/);
});

test('full Settings light-theme shell retains every control-surface route and primary binding', () => {
  for (const tab of [
    'providers', 'agents', 'workers', 'models', 'query', 'feeder',
    'skills', 'vibe', 'tiles', 'agency', 'system',
  ]) assert.match(settingsHtml, new RegExp(`data-stab="${tab}"`), `missing Settings tab ${tab}`);

  for (const id of [
    'settings-agent-select', 'onboarding-overlay', 'ob-oauth-host', 'ob-apikeys-host',
    'ob-save-keys', 'btn-save-models', 'btn-save-query', 'btn-save-feeder',
    'vibe-save', 'btn-save-tiles', 'btn-save-agency', 'btn-save-system',
  ]) assert.match(settingsHtml, new RegExp(`id="${id}"`), `missing Settings control #${id}`);

  assert.match(settingsCss, /body\.h23-settings-page \.h23s-config-sidebar\s*\{[^}]*background:\s*var\(--h23-glass-panel\)/);
  assert.match(settingsCss, /body\.h23-settings-page \.h23s-panel\s*\{[^}]*background:\s*var\(--h23-glass-panel\)/);
  assert.match(settingsCss, /body\.h23-settings-page :is\(input, select, textarea\)/);
});

test('standalone Chat, Vibe gallery, and Welcome retain their production bindings', () => {
  for (const id of [
    'sh-menu-btn', 'sh-title', 'sh-new-btn', 'chat-messages', 'chat-attach-tray',
    'chat-attach-btn', 'chat-attach-input', 'chat-input', 'chat-send-btn',
    'sh-drawer', 'chat-conv-list', 'sh-sheet', 'chat-agent-select', 'chat-model-select',
  ]) assert.match(standaloneChatHtml, new RegExp(`id="${id}"`), `missing standalone Chat control #${id}`);

  for (const id of [
    'meta-bar', 'gallery-grid', 'lightbox', 'lightbox-close', 'lightbox-image',
    'lightbox-caption', 'lightbox-seed', 'lightbox-prompt', 'lightbox-meta',
  ]) assert.match(vibeGalleryHtml, new RegExp(`id="${id}"`), `missing Vibe gallery control #${id}`);

  assert.match(welcomeHtml, /href="\/home23\/setup"/);
  assert.match(welcomeHtml, /id="welcome-version"/);
  assert.match(standaloneChatHtml, /body\.h23-chat-page \.sh-shell\s*\{[^}]*background:\s*var\(--h23-glass-card\)/);
  assert.match(vibeGalleryHtml, /body\.h23-vibe-page \.h23-vg-card\s*\{[^}]*background:\s*var\(--h23-glass-card\)/);
  assert.match(welcomeHtml, /body\.h23-welcome-page \.welcome-card\s*\{[^}]*background:\s*var\(--h23-glass-overlay\)/);
});

test('Welcome contains no visible emoji iconography', () => {
  const body = welcomeHtml.slice(welcomeHtml.indexOf('<body'));
  assert.doesNotMatch(body, /&#(?:x[0-9a-f]+|\d+);/i);
  assert.doesNotMatch(body, /\p{Extended_Pictographic}/u);
  assert.match(body, /class="welcome-logo"[^>]*>\s*H23\s*</);
});

test('standalone Chat page scope wins shared important paint rules and exposes select focus', () => {
  const pageStyle = standaloneChatHtml.match(/<style>([\s\S]*?)<\/style>/)?.[1] || '';
  const scoped = pageStyle.slice(pageStyle.indexOf('Glass Light standalone Chat surface'));

  assert.match(scoped, /body\.h23-chat-page\s*\{[^}]*background:\s*var\(--h23-bg-wash-1\),\s*var\(--h23-bg-wash-2\),\s*var\(--h23-bg\)\s*!important/);
  assert.match(scoped, /body\.h23-chat-page #particles-js\s*\{[^}]*display:\s*block\s*!important[^}]*opacity:\s*0\.1\s*!important/);
  assert.match(
    scoped,
    /body\.h23-chat-page :is\(\.sh-drawer, \.sh-sheet\)\s*\{[^}]*background:\s*var\(--h23-glass-overlay\)\s*!important/,
  );
  assert.match(
    scoped,
    /body\.h23-chat-page :is\(\.h23-chat-agent-select, \.h23-chat-model-select\):focus-visible\s*\{[^}]*outline:/,
  );
});

test('Settings compatibility colors preserve action contrast and follow real runtime states', () => {
  const scoped = settingsCss.slice(settingsCss.indexOf('Glass Light settings surface'));
  assert.match(settingsJs, /color:#fff[\s\S]{0,200}Restart to apply/);
  assert.match(scoped, /\[style\*="color:#fff"\]:not\(button\)/);
  assert.match(scoped, /\[style\*="color: #fff"\]:not\(button\)/);
  assert.doesNotMatch(scoped, /\.h23s-ob-check\.complete|\.h23s-onboarding-gate\.ready|\.h23s-(?:onboarding-launch-status|save-status)\.success|\.h23s-save-status\.error/);
  assert.match(scoped, /\.h23s-onboarding-step\.done \.h23s-onboarding-step-label/);
  assert.match(scoped, /\.h23s-ob-check\.done/);
  assert.match(scoped, /\.h23s-onboarding-gate\.satisfied/);
});

test('Vibe gallery image cards are native buttons wired to the unchanged lightbox path', async () => {
  const galleryScript = inlineScripts(vibeGalleryHtml).at(-1) || '';
  assert.match(galleryScript, /<button class="h23-vg-card"[^>]*type="button"/);
  assert.doesNotMatch(galleryScript, /class="h23-vg-card"[^>]*(?:role="button"|tabindex="0")/);
  const bindingStart = galleryScript.indexOf("grid.querySelectorAll('.h23-vg-card')");
  assert.notEqual(bindingStart, -1);
  const bindings = galleryScript.slice(bindingStart, galleryScript.indexOf('if (selectedId)', bindingStart));
  assert.match(bindings, /addEventListener\(['"]click['"]/);
  assert.doesNotMatch(bindings, /addEventListener\(['"]keydown['"]/);
  assert.match(bindings, /openLightbox\(item\)/);

  const makeElement = () => {
    const classes = new Set();
    const handlers = {};
    return {
      classes,
      handlers,
      classList: {
        add: (...names) => names.forEach((name) => classes.add(name)),
        remove: (...names) => names.forEach((name) => classes.delete(name)),
      },
      addEventListener: (type, handler) => { handlers[type] = handler; },
      textContent: '',
      src: '',
    };
  };
  const card = { ...makeElement(), dataset: { index: '0' } };
  const elements = new Map([
    ['gallery-grid', makeElement()],
    ['meta-bar', makeElement()],
    ['lightbox', makeElement()],
    ['lightbox-close', makeElement()],
    ['lightbox-image', makeElement()],
    ['lightbox-caption', makeElement()],
    ['lightbox-seed', makeElement()],
    ['lightbox-prompt', makeElement()],
    ['lightbox-meta', makeElement()],
  ]);
  elements.get('gallery-grid').querySelectorAll = () => [card];

  const galleryContext = vm.createContext({
    document: { getElementById: (id) => elements.get(id) },
    window: {
      location: { href: 'http://home23.test/home23/vibe', search: '' },
      history: { replaceState() {} },
      matchMedia: () => ({ matches: true }),
    },
    fetch: async () => ({
      json: async () => ({
        total: 1,
        storedTotal: 1,
        externalTotal: 0,
        images: [{ url: '/image.jpg', caption: 'Calm house', generatedAt: '2026-07-09T12:00:00Z' }],
      }),
    }),
    AbortSignal,
    URL,
    URLSearchParams,
    Date,
    Number,
  });
  await vm.runInContext(galleryScript, galleryContext);

  card.handlers.click();
  assert.equal(elements.get('lightbox').classes.has('open'), true, 'native button activation must open the lightbox');
});

test('reduced-motion preference causally prevents particle canvas initialization', () => {
  for (const [page, label] of [
    [settingsHtml, 'Settings'],
    [standaloneChatHtml, 'Standalone Chat'],
    [vibeGalleryHtml, 'Vibe gallery'],
    [welcomeHtml, 'Welcome'],
  ]) {
    const script = inlineScripts(page).at(-1) || '';
    const callIndex = script.indexOf("particlesJS('particles-js'");
    assert.notEqual(callIndex, -1, `${label} particle call is missing`);
    const beforeCall = script.slice(0, callIndex);
    assert.match(beforeCall, /matchMedia\?\.\(['"]\(prefers-reduced-motion: reduce\)['"]\)\.matches/);
    assert.match(beforeCall, /if\s*\(\s*!reduceMotion\s*&&\s*typeof particlesJS !== ['"]undefined['"]\s*\)/);
  }

  const chatStyle = standaloneChatHtml.match(/<style>([\s\S]*?)<\/style>/)?.[1] || '';
  assert.match(
    chatStyle,
    /@media\s*\(prefers-reduced-motion:\s*reduce\)\s*\{[\s\S]*?body\.h23-chat-page #particles-js\s*\{[^}]*display:\s*none\s*!important/,
  );
});

test('active navigation, sensor hover, and Vibe overlay match approved details', () => {
  const activeTab = css.match(/body\.h23-dashboard-page \.h23-topbar \.h23-tab\.active\s*\{([^}]+)\}/)?.[1] || '';
  assert.match(activeTab, /padding:\s*7px 16px/);
  assert.match(activeTab, /font-weight:\s*600/);
  assert.match(activeTab, /background:\s*rgba\(255,\s*255,\s*255,\s*0\.9\)/);
  assert.match(activeTab, /border:\s*1px solid rgba\(255,\s*255,\s*255,\s*1\)/);

  const sensorHover = css.match(/body\.h23-dashboard-page \.h23-human-sensor-strip button\.h23-human-card:hover\s*\{([^}]+)\}/)?.[1] || '';
  assert.match(sensorHover, /background:\s*var\(--h23-hover-card\)/);
  assert.doesNotMatch(sensorHover, /transform:/);

  const marker = css.indexOf('Glass Light dashboard system');
  const overrideCss = css.slice(marker);
  assert.doesNotMatch(overrideCss, /\.h23-vibe-detail-panel > header/);
  assert.match(overrideCss, /body\.h23-dashboard-page \.h23-vibe-detail-panel > \.h23-vibe-detail-close:first-child/);
  assert.match(overrideCss, /body\.h23-dashboard-page \.h23-vibe-detail-body\s*\{[^}]*border-top:\s*1px solid var\(--h23-hairline\)/);
});

test('glass shell stretches the top bar across the desktop row', () => {
  const shellRule = css.match(/body\.h23-dashboard-page \.h23-app-shell\s*\{([^}]+)\}/)?.[1] || '';
  assert.match(shellRule, /align-items:\s*stretch\s*;/);
});

test('sensor strip resets legacy 12-column spans while retaining resize states', () => {
  const cardRule = css.match(/body\.h23-dashboard-page \.h23-human-sensor-strip \.h23-human-card\s*\{([^}]+)\}/)?.[1] || '';
  assert.match(cardRule, /grid-column:\s*auto\s*;/);

  const halfRule = css.match(/body\.h23-dashboard-page \.h23-human-sensor-strip \.h23-human-card\[data-home-tile-size="half"\]\s*\{([^}]+)\}/)?.[1] || '';
  assert.match(halfRule, /grid-column:\s*span 2\s*;/);

  const fullRule = css.match(/body\.h23-dashboard-page \.h23-human-sensor-strip \.h23-human-card\[data-home-tile-size="full"\]\s*\{([^}]+)\}/)?.[1] || '';
  assert.match(fullRule, /grid-column:\s*1\s*\/\s*-1\s*;/);
});

test('phone sensor resize states collapse to the single available column', () => {
  const glassRules = css.slice(css.indexOf('Glass Light dashboard system'));
  const phoneRules = glassRules.match(/@media\s*\(max-width:\s*640px\)\s*\{([\s\S]*?)\n\}/)?.[1] || '';
  assert.match(
    phoneRules,
    /body\.h23-dashboard-page \.h23-human-sensor-strip \.h23-human-card\[data-home-tile-size\]\s*\{[^}]*grid-column:\s*1\s*\/\s*-1\s*;/,
  );
});

test('desktop top bar cancels legacy vertical sidebar navigation flow', () => {
  const navRule = css.match(/body\.h23-dashboard-page \.h23-topbar \.h23-tabs,\s*body\.h23-dashboard-page \.h23-linked-tabs\s*\{([^}]+)\}/)?.[1] || '';
  assert.match(navRule, /flex-direction:\s*row\s*;/);

  const tabRule = css.match(/body\.h23-dashboard-page \.h23-topbar \.h23-tab\s*\{([^}]+)\}/)?.[1] || '';
  assert.match(tabRule, /width:\s*auto\s*;/);
});

test('hidden sauna integration fields stay out of the rendered sensor card', () => {
  assert.match(
    css,
    /body\.h23-dashboard-page \.h23-integration-state\[hidden\]\s*\{[^}]*display:\s*none\s*!important\s*;/,
  );
});

test('glass top bar suppresses legacy decorative tab-label icons', () => {
  const iconReset = css.match(/body\.h23-dashboard-page \.h23-topbar \.h23-tab-label::before\s*\{([^}]+)\}/)?.[1] || '';
  assert.match(iconReset, /content:\s*none\s*;/);
  assert.match(iconReset, /display:\s*none\s*;/);
});

test('Chat remains the first explicit track in the glass Home main grid', () => {
  const chatRule = css.match(/body\.h23-dashboard-page \.h23-human-main-grid > \.h23-human-card-chat\s*\{([^}]+)\}/)?.[1] || '';
  assert.match(chatRule, /order:\s*0\s*;/);
  assert.match(chatRule, /grid-column:\s*auto\s*;/);
});

test('glass dashboard removes the legacy page inset', () => {
  const pageRule = css.match(/body\.h23-dashboard-page\s*\{([^}]+)\}/)?.[1] || '';
  assert.match(pageRule, /padding:\s*0\s*;/);
});

test('desktop hero extends through the content gutter while phone spacing stays inset', () => {
  const heroRule = css.match(/body\.h23-dashboard-page \.h23-human-hero\s*\{([^}]+)\}/)?.[1] || '';
  assert.match(heroRule, /margin-inline:\s*calc\(var\(--h23-gutter\) \* -1\)\s*;/);

  const glassRules = css.slice(css.indexOf('Glass Light dashboard system'));
  const phoneRules = glassRules.match(/@media\s*\(max-width:\s*640px\)\s*\{([\s\S]*?)\n\}/)?.[1] || '';
  assert.match(
    phoneRules,
    /body\.h23-dashboard-page \.h23-human-hero\s*\{[^}]*margin-inline:\s*0\s*;/,
  );
});

test('compact Home sauna card keeps actions while hiding redundant metric tiles', () => {
  for (const id of ['human-sauna-value', 'human-sauna-status', 'human-sauna-subtitle', 'human-sauna-actions', 'human-sauna-metrics']) {
    assert.match(html, new RegExp(`id="${id}"`), `missing preserved Sauna hook ${id}`);
  }
  assert.match(js, /renderHumanSensor\(['"]sauna['"],\s*payload/, 'Sauna metric renderer must remain wired');

  const compactRule = css.match(/body\.h23-dashboard-page \.h23-human-sensor-strip \.h23-human-card-sauna #human-sauna-metrics\s*\{([^}]+)\}/)?.[1] || '';
  assert.match(compactRule, /display:\s*none\s*;/);
});

test('phone top bar wraps navigation into reachable full-width rows', () => {
  const glassRules = css.slice(css.indexOf('Glass Light dashboard system'));
  const phoneRules = glassRules.match(/@media\s*\(max-width:\s*640px\)\s*\{([\s\S]*?)\n\}/)?.[1] || '';
  const topbarRule = phoneRules.match(/body\.h23-dashboard-page \.h23-topbar\s*\{([^}]+)\}/)?.[1] || '';
  assert.match(topbarRule, /flex-wrap:\s*wrap\s*;/);

  const navRule = phoneRules.match(/body\.h23-dashboard-page \.h23-topbar \.h23-tabs,\s*body\.h23-dashboard-page \.h23-linked-tabs\s*\{([^}]+)\}/)?.[1] || '';
  assert.match(navRule, /flex:\s*1 1 100%\s*;/);
  assert.match(navRule, /width:\s*100%\s*;/);
  assert.match(navRule, /overflow-x:\s*auto\s*;/);

  const runtimeRule = phoneRules.match(/body\.h23-dashboard-page \.h23-topbar-runtime\s*\{([^}]+)\}/)?.[1] || '';
  assert.match(runtimeRule, /flex:\s*1 1 100%\s*;/);
  assert.match(runtimeRule, /width:\s*100%\s*;/);
});

test('Vibe image is a semantic overlay invoker with preserved open-path wiring', () => {
  const tree = parseHtmlTree(html);
  const control = findById(tree, 'home-vibe-image');
  assert.equal(control?.tag, 'button');
  assert.equal(control?.attrs.get('type'), 'button');
  assert.match(control?.attrs.get('aria-label') || '', /Vibe image/i);

  const helperSource = functionFragment(js, 'configureVibeImageControl');
  const opened = [];
  const context = vm.createContext({
    openVibeImageDetail: (item, base) => opened.push({ item, base }),
  });
  const configure = vm.runInContext(`${helperSource}\nconfigureVibeImageControl`, context);
  const attrs = new Map();
  const imageControl = {
    disabled: true,
    onclick: null,
    setAttribute: (name, value) => attrs.set(name, String(value)),
  };
  const item = { url: '/vibe.jpg', caption: 'Quiet workshop' };

  configure(imageControl, item, '/jerry');
  assert.equal(imageControl.disabled, false);
  assert.equal(attrs.get('aria-disabled'), 'false');
  assert.match(attrs.get('aria-label'), /Open Vibe image: Quiet workshop/);
  imageControl.onclick();
  assert.deepEqual(opened, [{ item, base: '/jerry' }]);

  configure(imageControl, null, '/jerry');
  assert.equal(imageControl.disabled, true);
  assert.equal(attrs.get('aria-disabled'), 'true');
  assert.equal(imageControl.onclick, null);
  assert.match(functionFragment(js, 'loadVibeTile'), /configureVibeImageControl/);
});

test('Home Vibe modal navigates the read-only gallery with honest boundaries and fallback', () => {
  for (const id of [
    'home-vibe-detail-previous', 'home-vibe-detail-next', 'home-vibe-detail-position',
    'home-vibe-detail-open', 'home-vibe-detail-gallery',
  ]) assert.match(html, new RegExp(`id="${id}"`), `missing Vibe modal navigation #${id}`);

  const runtime = createDashboardRuntime();
  for (const id of [
    'home-vibe-detail-modal', 'home-vibe-detail-image', 'home-vibe-detail-source',
    'home-vibe-detail-title', 'home-vibe-detail-caption', 'home-vibe-detail-prompt',
    'home-vibe-detail-meta', 'home-vibe-detail-open', 'home-vibe-detail-gallery',
    'home-vibe-detail-previous', 'home-vibe-detail-next', 'home-vibe-detail-position',
  ]) runtime.document.createElement(id, {
    tagName: id.includes('previous') || id.includes('next') ? 'BUTTON' : id.includes('open') || id.includes('gallery') ? 'A' : 'DIV',
  });
  runtime.context.__vibeItems = [
    { id: 'one', url: '/one.jpg', caption: 'First image', prompt: 'First prompt' },
    { id: 'two', url: '/two.jpg', caption: 'Second image', prompt: 'Second prompt' },
  ];
  runtime.run(`
    renderVibeImageDetail(globalThis.__vibeItems[0], '/jerry');
    showVibeImageDetail();
    setVibeDetailGallery(globalThis.__vibeItems, globalThis.__vibeItems[0], '/jerry');
  `);
  const previous = runtime.document.getElementById('home-vibe-detail-previous');
  const next = runtime.document.getElementById('home-vibe-detail-next');
  const position = runtime.document.getElementById('home-vibe-detail-position');
  assert.equal(previous.disabled, true);
  assert.equal(next.disabled, false);
  assert.equal(position.textContent, '1 of 2');

  runtime.run('navigateVibeImageDetail(1)');
  assert.equal(runtime.document.getElementById('home-vibe-detail-caption').textContent, 'Second image');
  assert.equal(previous.disabled, false);
  assert.equal(next.disabled, true);
  assert.equal(position.textContent, '2 of 2');
  runtime.run('navigateVibeImageDetail(1)');
  assert.equal(runtime.document.getElementById('home-vibe-detail-caption').textContent, 'Second image', 'boundary navigation must not blank the modal');

  runtime.run(`setVibeDetailGallery([], globalThis.__vibeItems[1], '/jerry', { unavailable: true })`);
  assert.equal(previous.disabled, true);
  assert.equal(next.disabled, true);
  assert.match(position.textContent, /Gallery unavailable/i);
  assert.equal(runtime.document.getElementById('home-vibe-detail-caption').textContent, 'Second image');

  const open = functionClosure(js, ['openVibeImageDetail', 'loadVibeDetailGallery']);
  assert.match(open, /\/home23\/api\/vibe\/gallery\?limit=all/);
  assert.match(open, /\/home23\/api\/vibe\/gallery\/items\//);
});

test('Vibe detail ignores stale or post-close async results and keeps visibility explicit', async () => {
  const runtime = createDashboardRuntime();
  for (const id of [
    'home-vibe-detail-modal', 'home-vibe-detail-image', 'home-vibe-detail-source',
    'home-vibe-detail-title', 'home-vibe-detail-caption', 'home-vibe-detail-prompt',
    'home-vibe-detail-meta', 'home-vibe-detail-open', 'home-vibe-detail-gallery',
    'home-vibe-detail-previous', 'home-vibe-detail-next', 'home-vibe-detail-position',
  ]) runtime.document.createElement(id, {
    tagName: id.includes('previous') || id.includes('next') ? 'BUTTON' : id.includes('open') || id.includes('gallery') ? 'A' : 'DIV',
  });

  const pending = new Map();
  runtime.context.__vibeFetch = (url) => new Promise((resolve) => pending.set(url, resolve));
  runtime.run('apiFetch = globalThis.__vibeFetch');

  runtime.context.__oldVibe = { id: 'old', url: '/old.jpg', caption: 'Old image' };
  runtime.context.__newVibe = { id: 'new', url: '/new.jpg', caption: 'New image' };
  const oldOpen = runtime.run("openVibeImageDetail(globalThis.__oldVibe, '/old')");
  const newOpen = runtime.run("openVibeImageDetail(globalThis.__newVibe, '/new')");

  pending.get('/new/home23/api/vibe/gallery?limit=all')({ images: [runtime.context.__newVibe] });
  pending.get('/new/home23/api/vibe/gallery/items/new')({ item: runtime.context.__newVibe });
  await newOpen;
  const modal = runtime.document.getElementById('home-vibe-detail-modal');
  const caption = runtime.document.getElementById('home-vibe-detail-caption');
  assert.equal(modal.classList.contains('open'), true);
  assert.equal(caption.textContent, 'New image');

  pending.get('/old/home23/api/vibe/gallery?limit=all')({ images: [runtime.context.__oldVibe] });
  pending.get('/old/home23/api/vibe/gallery/items/old')({ item: runtime.context.__oldVibe });
  await oldOpen;
  assert.equal(caption.textContent, 'New image', 'an older request must not overwrite the newer interaction');

  runtime.context.__closedVibe = { id: 'closed', url: '/closed.jpg', caption: 'Closed image' };
  const closedOpen = runtime.run("openVibeImageDetail(globalThis.__closedVibe, '/closed')");
  runtime.run('closeVibeImageDetail()');
  pending.get('/closed/home23/api/vibe/gallery?limit=all')({ images: [runtime.context.__closedVibe] });
  pending.get('/closed/home23/api/vibe/gallery/items/closed')({ item: runtime.context.__closedVibe });
  await closedOpen;
  assert.equal(modal.classList.contains('open'), false, 'post-close data must not reopen the modal');
  assert.equal(modal.getAttribute('aria-hidden'), 'true');
  assert.equal(runtime.document.getElementById('home-vibe-detail-image').src, '');

  assert.doesNotMatch(functionFragment(js, 'renderVibeImageDetail'), /classList\.add\(['"]open['"]\)/);
  assert.match(functionFragment(js, 'showVibeImageDetail'), /classList\.add\(['"]open['"]\)/);
  assert.doesNotMatch(functionFragment(js, 'setVibeDetailGallery'), /renderVibeImageDetail/);
});

test('Vibe navigation supersedes the opening image slower detail response', async () => {
  const runtime = createDashboardRuntime();
  for (const id of [
    'home-vibe-detail-modal', 'home-vibe-detail-image', 'home-vibe-detail-source',
    'home-vibe-detail-title', 'home-vibe-detail-caption', 'home-vibe-detail-prompt',
    'home-vibe-detail-meta', 'home-vibe-detail-open', 'home-vibe-detail-gallery',
    'home-vibe-detail-previous', 'home-vibe-detail-next', 'home-vibe-detail-position',
  ]) runtime.document.createElement(id, {
    tagName: id.includes('previous') || id.includes('next') ? 'BUTTON' : id.includes('open') || id.includes('gallery') ? 'A' : 'DIV',
  });

  runtime.context.__vibeA = { id: 'a', url: '/a.jpg', caption: 'Image A' };
  runtime.context.__vibeB = { id: 'b', url: '/b.jpg', caption: 'Image B' };
  let resolveDetail;
  const detailPromise = new Promise((resolve) => { resolveDetail = resolve; });
  runtime.context.__vibeFetch = (url) => url.includes('?limit=all')
    ? Promise.resolve({ images: [runtime.context.__vibeA, runtime.context.__vibeB] })
    : detailPromise;
  runtime.run('apiFetch = globalThis.__vibeFetch');

  const open = runtime.run("openVibeImageDetail(globalThis.__vibeA, '/jerry')");
  await new Promise((resolve) => setImmediate(resolve));
  const caption = runtime.document.getElementById('home-vibe-detail-caption');
  const position = runtime.document.getElementById('home-vibe-detail-position');
  assert.equal(position.textContent, '1 of 2', 'gallery must settle while the original detail request stays pending');

  runtime.run('navigateVibeImageDetail(1)');
  assert.equal(caption.textContent, 'Image B');
  assert.equal(position.textContent, '2 of 2');

  resolveDetail({
    item: { id: 'a', url: '/a.jpg', caption: 'Image A detailed', prompt: 'Late detail for A' },
  });
  await open;
  assert.equal(caption.textContent, 'Image B', 'late detail for A must not replace navigated image B');
  assert.equal(position.textContent, '2 of 2', 'late detail for A must not reset the gallery position');
  assert.equal(runtime.document.getElementById('home-vibe-detail-previous').disabled, false);
  assert.equal(runtime.document.getElementById('home-vibe-detail-next').disabled, true);
});

test('COSMO new-tab control receives the resolved runtime URL without a hash placeholder', () => {
  const tree = parseHtmlTree(html);
  const link = findById(tree, 'cosmo23-open-link');
  assert.equal(link?.tag, 'a');
  assert.notEqual(link?.attrs.get('href'), '#');

  const helperSource = functionFragment(js, 'configureCosmoOpenLink');
  const configure = vm.runInNewContext(`${helperSource}\nconfigureCosmoOpenLink`);
  const attrs = new Map([['href', '#']]);
  const control = {
    href: '#',
    setAttribute: (name, value) => attrs.set(name, String(value)),
    removeAttribute: (name) => attrs.delete(name),
  };

  configure(control, 'http://127.0.0.1:43210');
  assert.equal(control.href, 'http://127.0.0.1:43210');
  assert.equal(attrs.get('aria-disabled'), 'false');

  configure(control, '');
  assert.equal(attrs.has('href'), false);
  assert.equal(attrs.get('aria-disabled'), 'true');
  assert.match(functionFragment(js, 'loadAgents'), /configureCosmoOpenLink/);
});

test('full Settings description overrides the legacy pale dark-theme text', () => {
  assert.match(
    settingsCss,
    /body\.h23-settings-page #settings-surface-desc\s*\{[^}]*color:\s*var\(--h23-text-secondary\)\s*;/,
  );
});

test('standalone desktop Chat uses explicit viewport-safe fixed-shell geometry', () => {
  const lightScope = standaloneChatHtml.slice(standaloneChatHtml.indexOf('Glass Light standalone Chat surface'));
  const desktopRule = lightScope.match(/@media\s*\(min-width:\s*820px\)\s*\{[\s\S]*?body\.h23-chat-page \.sh-shell\s*\{([^}]+)\}/)?.[1] || '';
  assert.match(desktopRule, /left:\s*50%\s*;/);
  assert.match(desktopRule, /right:\s*auto\s*;/);
  assert.match(desktopRule, /width:\s*min\(880px,\s*calc\(100vw - 48px\)\)\s*;/);
  assert.match(desktopRule, /margin:\s*0\s*;/);
  assert.match(desktopRule, /transform:\s*translateX\(-50%\)\s*;/);
});
