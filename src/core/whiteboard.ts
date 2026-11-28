// The white screen is a whiteboard (Ben, 2026-11-28): Draw comes on with it and goes off with it.

/**
 * Follows the audience screen in and out of white for one device's Draw tool. Draw is turned on
 * when the screen goes white, and off again when it leaves white, unless Draw was already on
 * before (then it stays as the presenter left it).
 */
export class WhiteboardDraw {
  private white = false;
  private turnedOn = false;

  /** Call with every state seen. Returns what Draw should become, or null to leave it alone. */
  follow(white: boolean, drawing: boolean): boolean | null {
    if (white === this.white) return null;
    this.white = white;
    if (white) {
      this.turnedOn = !drawing;
      return drawing ? null : true;
    }
    const off = this.turnedOn && drawing;
    this.turnedOn = false;
    return off ? false : null;
  }
}
