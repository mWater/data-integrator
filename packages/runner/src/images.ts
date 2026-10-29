import { RuntimeId } from "./contract.js"

/**
 * Version of this package and of the runtime images released with it. The
 * harness inside each image is the contract the runner depends on, so the
 * three artifacts share one version and the release script stamps it here
 * and in package.json together.
 */
export const RUNTIME_VERSION = "0.3.0"

/** Registry path of the runtime images, without tag. */
export const RUNTIME_IMAGE_REPOSITORY = "ghcr.io/mwater/integration-runtime"

/**
 * Runtime images this runner version was tested against. Consumers pass one
 * of these as JobSpec.image rather than spelling a tag themselves, so
 * bumping the package dependency is the whole upgrade.
 */
export const RUNTIME_IMAGES: Record<RuntimeId, string> = {
  node: `${RUNTIME_IMAGE_REPOSITORY}-node:${RUNTIME_VERSION}`,
  python: `${RUNTIME_IMAGE_REPOSITORY}-python:${RUNTIME_VERSION}`
}
