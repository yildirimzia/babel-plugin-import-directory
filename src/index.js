const template = require('@babel/template').default;
const path = require('path');
const fs = require('fs');

const wildcardRegex = /\/\*$/;
const recursiveRegex = /\/\*\*$/;

const buildRequire = template(`
  for (let key in IMPORTED) {
    DIR_IMPORT[key === 'default' ? IMPORTED_NAME : key] = IMPORTED[key];
  }
`);

const toCamelCase = (name) =>
  name.replace(/([-_.]\w)/g, (_, $1) => $1[1].toUpperCase());

const toSnakeCase = (name) =>
  name.replace(/([-.A-Z])/g, (_, $1) => '_' + ($1 === '.' || $1 === '-' ? '' : $1.toLowerCase()));

const getFiles = (parent, exts = ['.js', '.es6', '.es', '.jsx'], files = [], recursive = false, currentPath = []) => {
  const entries = fs.readdirSync(parent);

  for (const entry of entries) {
    const fullPath = path.join(parent, entry);
    const { name, ext } = path.parse(entry);
    const entryPath = currentPath.concat(name);

    if (exts.includes(ext)) {
      files.push(entryPath);
    } else if (recursive && fs.statSync(fullPath).isDirectory()) {
      getFiles(fullPath, exts, files, recursive, entryPath);
    }
  }

  return files;
};

module.exports = function dirImportPlugin(babel) {
  const { types: t } = babel;

  return {
    visitor: {
      ImportDeclaration(pathNode, state) {
        const { node } = pathNode;
        let src = node.source.value;

        if (src[0] !== '.' && src[0] !== '/') return;

        const pathPrefix = src.split('/')[0] + '/';

        const isExplicitWildcard = wildcardRegex.test(src);
        let cleanedPath = src.replace(wildcardRegex, '');

        const isRecursive = recursiveRegex.test(cleanedPath);
        cleanedPath = cleanedPath.replace(recursiveRegex, '');

        const sourcePath =
          state.file.opts.parserOpts.sourceFileName ||
          state.file.opts.parserOpts.filename ||
          '';

        const resolvedPath = path.resolve(path.join(path.dirname(sourcePath), cleanedPath));

        try {
          require.resolve(resolvedPath);
          return;
        } catch (_) {}

        try {
          if (!fs.statSync(resolvedPath).isDirectory()) return;
        } catch (_) {
          return;
        }

        const nameTransform = state.opts.snakeCase ? toSnakeCase : toCamelCase;

        const fileList = getFiles(resolvedPath, state.opts.exts, [], isRecursive);
        const files = fileList.map((file) => {
          const last = file[file.length - 1];
          return [file, nameTransform(last), pathNode.scope.generateUidIdentifier(last)];
        });

        if (!files.length) return;

        const imports = files.map(([file, , uid]) =>
          t.importDeclaration(
            [t.importNamespaceSpecifier(uid)],
            t.stringLiteral(pathPrefix + path.join(cleanedPath, ...file))
          )
        );

        const dirVar = pathNode.scope.generateUidIdentifier('dirImport');
        pathNode.insertBefore(
          t.variableDeclaration('const', [
            t.variableDeclarator(dirVar, t.objectExpression([])),
          ])
        );

        for (let i = node.specifiers.length - 1; i >= 0; i--) {
          const spec = node.specifiers[i];

          if (t.isImportNamespaceSpecifier(spec) || t.isImportDefaultSpecifier(spec)) {
            pathNode.insertAfter(
              t.variableDeclaration('const', [
                t.variableDeclarator(t.identifier(spec.local.name), dirVar),
              ])
            );
          }

          if (t.isImportSpecifier(spec)) {
            pathNode.insertAfter(
              t.variableDeclaration('const', [
                t.variableDeclarator(
                  t.identifier(spec.local.name),
                  t.memberExpression(dirVar, t.identifier(spec.imported.name))
                ),
              ])
            );
          }
        }

        if (isExplicitWildcard) {
          files.forEach(([, name, uid]) => {
            pathNode.insertAfter(
              buildRequire({
                IMPORTED_NAME: t.stringLiteral(name),
                DIR_IMPORT: dirVar,
                IMPORTED: uid,
              })
            );
          });
        } else {
          files.forEach(([, name, uid]) => {
            pathNode.insertAfter(
              t.expressionStatement(
                t.assignmentExpression(
                  '=',
                  t.memberExpression(dirVar, t.identifier(name)),
                  uid
                )
              )
            );
          });
        }

        pathNode.replaceWithMultiple(imports);
      },
    },
  };
};
