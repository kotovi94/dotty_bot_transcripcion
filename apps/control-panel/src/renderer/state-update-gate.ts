export class StateUpdateGate {
  private generation = 0;
  beginRequest(): number { return ++this.generation; }
  acceptEvent(): void { this.generation += 1; }
  isCurrent(request: number): boolean { return request === this.generation; }
}
