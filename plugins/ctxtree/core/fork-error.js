export class ForkError extends Error {
  constructor(message, problems = []) { super(message); this.problems = problems; }
}
