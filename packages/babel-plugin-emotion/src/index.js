// @flow
import { createEmotionMacro } from './macro'
import { createStyledMacro } from './styled-macro'
import cssMacro, { transformCssCallExpression } from './css-macro'
import { addDefault } from '@babel/helper-module-imports'
import nodePath from 'path'
import { getSourceMap, getStyledOptions } from './utils'

let webStyledMacro = createStyledMacro({
  importPath: '@emotion/styled-base',
  isWeb: true
})
let nativeStyledMacro = createStyledMacro({
  importPath: '@emotion/native',
  isWeb: false
})
let primitivesStyledMacro = createStyledMacro({
  importPath: '@emotion/primitives',
  isWeb: false
})

export const macros = {
  createEmotionMacro,
  css: cssMacro,
  createStyledMacro
}

export type BabelPath = any

export type EmotionBabelPluginPass = any

let emotionCoreMacroThatsNotARealMacro = ({ references, state, babel }) => {
  Object.keys(references).forEach(refKey => {
    if (refKey === 'css') {
      references[refKey].forEach(path => {
        transformCssCallExpression({ babel, state, path: path.parentPath })
      })
    }
  })
}
emotionCoreMacroThatsNotARealMacro.keepImport = true

function getAbsolutePath(instancePath: string, rootPath: string) {
  if (instancePath.charAt(0) === '.') {
    let absoluteInstancePath = nodePath.resolve(rootPath, instancePath)
    return absoluteInstancePath
  }
  return false
}

function getInstancePathToCompare(instancePath: string, rootPath: string) {
  let absolutePath = getAbsolutePath(instancePath, rootPath)
  if (absolutePath === false) {
    return instancePath
  }
  return absolutePath
}

export default function(babel: *) {
  let t = babel.types
  return {
    name: 'emotion',
    inherits: require('babel-plugin-syntax-jsx'),
    visitor: {
      ImportDeclaration(path: *, state: *) {
        const hasFilepath =
          path.hub.file.opts.filename &&
          path.hub.file.opts.filename !== 'unknown'
        let dirname = hasFilepath
          ? nodePath.dirname(path.hub.file.opts.filename)
          : ''

        if (
          !state.pluginMacros[path.node.source.value] &&
          state.emotionInstancePaths.indexOf(
            getInstancePathToCompare(path.node.source.value, dirname)
          ) !== -1
        ) {
          state.pluginMacros[path.node.source.value] = createEmotionMacro(
            path.node.source.value
          )
        }
        let pluginMacros = state.pluginMacros
        // most of this is from https://github.com/kentcdodds/babel-plugin-macros/blob/master/src/index.js
        if (pluginMacros[path.node.source.value] === undefined) {
          return
        }
        if (t.isImportNamespaceSpecifier(path.node.specifiers[0])) {
          return
        }
        const imports = path.node.specifiers.map(s => ({
          localName: s.local.name,
          importedName:
            s.type === 'ImportDefaultSpecifier' ? 'default' : s.imported.name
        }))
        let shouldExit = false
        let hasReferences = false
        const referencePathsByImportName = imports.reduce(
          (byName, { importedName, localName }) => {
            let binding = path.scope.getBinding(localName)
            if (!binding) {
              shouldExit = true
              return byName
            }
            byName[importedName] = binding.referencePaths
            hasReferences =
              hasReferences || Boolean(byName[importedName].length)
            return byName
          },
          {}
        )
        if (!hasReferences || shouldExit) {
          return
        }
        /**
         * Other plugins that run before babel-plugin-macros might use path.replace, where a path is
         * put into its own replacement. Apparently babel does not update the scope after such
         * an operation. As a remedy, the whole scope is traversed again with an empty "Identifier"
         * visitor - this makes the problem go away.
         *
         * See: https://github.com/kentcdodds/import-all.macro/issues/7
         */
        state.file.scope.path.traverse({
          Identifier() {}
        })

        pluginMacros[path.node.source.value]({
          references: referencePathsByImportName,
          state,
          babel,
          isBabelMacrosCall: true
        })
        if (!pluginMacros[path.node.source.value].keepImport) {
          path.remove()
        }
      },
      Program(path: *, state: *) {
        state.emotionInstancePaths = (state.opts.instances || []).map(
          instancePath => getInstancePathToCompare(instancePath, process.cwd())
        )
        state.pluginMacros = {
          '@emotion/css': cssMacro,
          '@emotion/styled': webStyledMacro,
          '@emotion/core': emotionCoreMacroThatsNotARealMacro,
          'react-emotion': webStyledMacro,
          '@emotion/primitives': primitivesStyledMacro,
          '@emotion/native': nativeStyledMacro,
          emotion: createEmotionMacro('emotion')
        }
        if (state.opts.cssPropOptimization === undefined) {
          for (const node of path.node.body) {
            if (
              t.isImportDeclaration(node) &&
              node.source.value === '@emotion/core' &&
              node.specifiers.some(
                x => t.isImportSpecifier(x) && x.imported.name === 'jsx'
              )
            ) {
              state.transformCssProp = true
              break
            }
          }
        } else {
          state.transformCssProp = state.opts.cssPropOptimization
        }

        if (state.opts.sourceMap) {
          state.emotionSourceMap = true
        }
      },
      JSXAttribute(path: *, state: *) {
        if (path.node.name.name !== 'css' || !state.transformCssProp) {
          return
        }

        if (
          t.isJSXExpressionContainer(path.node.value) &&
          (t.isObjectExpression(path.node.value.expression) ||
            t.isArrayExpression(path.node.value.expression))
        ) {
          let expressionPath = path.get('value.expression')
          if (expressionPath.isPure()) {
            if (!state.cssIdentifier) {
              state.cssIdentifier = addDefault(path, '@emotion/css', {
                nameHint: 'css'
              })
            }
            expressionPath.replaceWith(
              t.callExpression(
                t.cloneDeep(state.cssIdentifier),
                [
                  path.node.value.expression,
                  state.emotionSourceMap &&
                    path.node.loc !== undefined &&
                    t.stringLiteral(getSourceMap(path.node.loc.start, state))
                ].filter(Boolean)
              )
            )
            transformCssCallExpression({
              babel,
              state,
              path: expressionPath
            })
          }
        }
      },
      CallExpression: {
        exit(path: BabelPath, state: EmotionBabelPluginPass) {
          try {
            if (
              path.node.callee &&
              path.node.callee.property &&
              path.node.callee.property.name === 'withComponent'
            ) {
              switch (path.node.arguments.length) {
                case 1:
                case 2: {
                  path.node.arguments[1] = getStyledOptions(t, path, state)
                }
              }
            }
          } catch (e) {
            throw path.buildCodeFrameError(e)
          }
        }
      }
    }
  }
}
