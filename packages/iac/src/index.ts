/**
 * Infrastructure generator registry.
 *
 * `haic deploy --iac-target <id>` looks the platform up here. Supporting another
 * one means writing a new file and adding a `.register(...)` line: none of the
 * existing generators changes.
 */
import { Registry, type GenerationContext, type GenerationResult, type InfrastructureGenerator } from '@haic/core';
import { awsGenerator } from './targets/aws.js';
import { dockerGenerator } from './targets/docker.js';
import { kubernetesGenerator } from './targets/kubernetes.js';
import { terraformGenerator } from './targets/terraform.js';

export const infrastructureGenerators = new Registry<InfrastructureGenerator>()
  .register(dockerGenerator)
  .register(kubernetesGenerator)
  .register(terraformGenerator)
  .register(awsGenerator);

/** Runs one platform over the whole project. Infrastructure is never per-module. */
export function generateInfrastructure(
  generator: InfrastructureGenerator,
  context: GenerationContext,
): GenerationResult {
  return generator.generate(context);
}

export { awsGenerator } from './targets/aws.js';
export { dockerGenerator } from './targets/docker.js';
export { kubernetesGenerator } from './targets/kubernetes.js';
export { terraformGenerator } from './targets/terraform.js';
export { buildPlan, InfrastructurePlan, type ContextPlan } from './shared/plan.js';
export { IAC_CODE } from './shared/diagnostics.js';
