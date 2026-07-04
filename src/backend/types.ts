export interface Backend {
  // Fetch a Redlib-style path (e.g. "/r/x/hot") and return HTML, or throw a RedlibError.
  fetch(path: string): Promise<string>;
}
