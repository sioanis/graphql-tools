import {
  GraphQLSchema,
  visit,
  Kind,
  TypeInfo,
  visitWithTypeInfo,
  OperationDefinitionNode,
  FragmentDefinitionNode,
  VariableDefinitionNode,
  ArgumentNode,
  GraphQLArgument,
  FieldNode,
  valueFromAST,
  isLeafType,
} from 'graphql';

import {
  Transform,
  Request,
  ExecutionResult,
  visitResult,
  ResultVisitorMap,
  updateArgument,
  transformInputValue,
} from '@graphql-tools/utils';

import { LeafValueTransformer } from '../types';

export interface MapLeafValuesTransformationContext {
  transformedRequest: Request;
}

export default class MapLeafValues implements Transform<MapLeafValuesTransformationContext> {
  private readonly inputValueTransformer: LeafValueTransformer;
  private readonly outputValueTransformer: LeafValueTransformer;
  private readonly resultVisitorMap: ResultVisitorMap;
  private originalSchema: GraphQLSchema;
  private typeInfo: TypeInfo;

  constructor(inputValueTransformer: LeafValueTransformer, outputValueTransformer: LeafValueTransformer) {
    this.inputValueTransformer = inputValueTransformer;
    this.outputValueTransformer = outputValueTransformer;
    this.resultVisitorMap = Object.create(null);
  }

  public transformSchema(originalSchema: GraphQLSchema): GraphQLSchema {
    this.originalSchema = originalSchema;
    const typeMap = originalSchema.getTypeMap();
    Object.keys(typeMap).forEach(typeName => {
      const type = typeMap[typeName];
      if (!typeName.startsWith('__')) {
        if (isLeafType(type)) {
          this.resultVisitorMap[typeName] = (value: any) => this.outputValueTransformer(typeName, value);
        }
      }
    });
    this.typeInfo = new TypeInfo(originalSchema);
    return originalSchema;
  }

  public transformRequest(
    originalRequest: Request,
    _delegationContext?: Record<string, any>,
    transformationContext?: MapLeafValuesTransformationContext
  ): Request {
    const document = originalRequest.document;
    const variableValues = originalRequest.variables;

    const operations: Array<OperationDefinitionNode> = document.definitions.filter(
      def => def.kind === Kind.OPERATION_DEFINITION
    ) as Array<OperationDefinitionNode>;
    const fragments: Array<FragmentDefinitionNode> = document.definitions.filter(
      def => def.kind === Kind.FRAGMENT_DEFINITION
    ) as Array<FragmentDefinitionNode>;

    const newOperations = this.transformOperations(operations, variableValues);

    const transformedRequest = {
      ...originalRequest,
      document: {
        ...document,
        definitions: [...newOperations, ...fragments],
      },
      variables: variableValues,
    };

    transformationContext.transformedRequest = transformedRequest;

    return transformedRequest;
  }

  public transformResult(
    originalResult: ExecutionResult,
    _delegationContext?: Record<string, any>,
    transformationContext?: MapLeafValuesTransformationContext
  ) {
    return visitResult(
      originalResult,
      transformationContext.transformedRequest,
      this.originalSchema,
      this.resultVisitorMap
    );
  }

  private transformOperations(
    operations: Array<OperationDefinitionNode>,
    variableValues: Record<string, any>
  ): Array<OperationDefinitionNode> {
    return operations.map((operation: OperationDefinitionNode) => {
      const variableDefinitionMap: Record<string, VariableDefinitionNode> = operation.variableDefinitions.reduce(
        (prev, def) => ({
          ...prev,
          [def.variable.name.value]: def,
        }),
        {}
      );

      const newOperation = visit(
        operation,
        visitWithTypeInfo(this.typeInfo, {
          [Kind.FIELD]: node => this.transformFieldNode(node, variableDefinitionMap, variableValues),
        })
      );

      return {
        ...newOperation,
        variableDefinitions: Object.keys(variableDefinitionMap).map(varName => variableDefinitionMap[varName]),
      };
    });
  }

  private transformFieldNode(
    field: FieldNode,
    variableDefinitionMap: Record<string, VariableDefinitionNode>,
    variableValues: Record<string, any>
  ): FieldNode {
    const targetField = this.typeInfo.getFieldDef();

    if (!targetField.name.startsWith('__')) {
      const argumentNodes = field.arguments;
      if (argumentNodes != null) {
        const argumentNodeMap: Record<string, ArgumentNode> = argumentNodes.reduce(
          (prev, argument) => ({
            ...prev,
            [argument.name.value]: argument,
          }),
          Object.create(null)
        );

        targetField.args.forEach((argument: GraphQLArgument) => {
          const argName = argument.name;
          const argType = argument.type;

          const argumentNode = argumentNodeMap[argName];
          const argValue = argumentNode?.value;

          let value: any;
          if (argValue != null) {
            value = valueFromAST(argValue, argType, variableValues);
          }

          updateArgument(
            argName,
            argType,
            argumentNodeMap,
            variableDefinitionMap,
            variableValues,
            transformInputValue(argType, value, (t, v) => {
              const newValue = this.inputValueTransformer(t.name, v);
              return newValue === undefined ? v : newValue;
            })
          );
        });

        return {
          ...field,
          arguments: Object.keys(argumentNodeMap).map(argName => argumentNodeMap[argName]),
        };
      }
    }
  }
}
