import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import ts from 'typescript';

const HOME23_ROOT = process.cwd();
const read = (relativePath) => fs.readFileSync(path.join(HOME23_ROOT, relativePath), 'utf8');

const html = read('engine/src/dashboard/home23-dashboard.html');
const js = read('engine/src/dashboard/home23-dashboard.js');
const css = read('engine/src/dashboard/home23-dashboard.css');
const chatCss = read('engine/src/dashboard/home23-chat.css');
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
  assert.match(
    html,
    /id="chat-attach-btn"[^>]*aria-label="Attach image"[^>]*>[\s\S]*?&#x1F4CE;&#xFE0E;[\s\S]*?<\/button>/i,
  );
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

test('dashboard Settings is a read-only overview linked to the full control surface', () => {
  assert.match(html, /id="panel-settings"/);
  assert.match(js, /loadSettingsOverview/);

  const settingsPanel = fragmentFromId(html, 'panel-settings', '<div class="h23-panel"');
  for (const hash of ['agents', 'feeder', 'models', 'vibe']) {
    assert.match(settingsPanel, new RegExp(`href="/home23/settings#${hash}"`));
  }
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
