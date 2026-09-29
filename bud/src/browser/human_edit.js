// Runs against the remembered remote object. Validate and edit in one JS task.
function budHumanEdit(mode, value) {
  const doc = this.ownerDocument;
  let active = doc.activeElement;
  while (active?.shadowRoot?.activeElement) active = active.shadowRoot.activeElement;
  if (!this.isConnected || active !== this || this.disabled || this.readOnly) return false;
  if (this.isContentEditable) {
    if (this.closest('[aria-readonly="true"], [aria-disabled="true"]')) return false;
    const root = this.getRootNode();
    const selection = root.getSelection ? root.getSelection() : doc.getSelection();
    if (!selection || selection.rangeCount !== 1) return false;
    const range = selection.getRangeAt(0);
    const within = node => {
      if (!this.contains(node)) return false;
      let element = node.nodeType === 1 ? node : node.parentElement;
      while (element && element !== this) {
        if (!element.isContentEditable || element.hasAttribute('contenteditable')) return false;
        element = element.parentElement;
      }
      return element === this;
    };
    if (!within(range.startContainer) || !within(range.endContainer)) return false;
    // A range with safe endpoints may still cross an embedded noneditable widget.
    for (const island of this.querySelectorAll('[contenteditable]')) {
      if (range.intersectsNode(island)) return false;
    }
    if (mode === 'probe') return true;
    // execCommand keeps Chrome's rich editing/undo behavior, unlike textContent.
    // It is used only for this Chrome-owned committed-text path (not IME composition).
    if (mode === 'text') return doc.execCommand('insertText', false, value);
    const command = {Backspace: 'delete', Delete: 'forwardDelete', Enter: 'insertParagraph'}[value];
    if (value === 'Backspace') {
      // Model-backed editors must see deletion intent before DOM mutation.
      // execCommand alone emits input but can have its final-node removal undone.
      const start = range.startContainer, startOffset = range.startOffset;
      const end = range.endContainer, endOffset = range.endOffset;
      const allowed = this.dispatchEvent(new InputEvent('beforeinput', {
        bubbles: true, composed: true, cancelable: true,
        inputType: 'deleteContentBackward'
      }));
      if (!allowed) return true; // The editor owns this gesture; never delete twice.
      // A handler may move focus/selection synchronously without cancelling.
      if (!budHumanEdit.call(this, 'probe')) return false;
      const current = selection.getRangeAt(0);
      if (current.startContainer !== start || current.startOffset !== startOffset ||
          current.endContainer !== end || current.endOffset !== endOffset) return false;
    }
    if (command) return doc.execCommand(command, false);
    return false;
  }
  const ordinary = this instanceof HTMLTextAreaElement ||
    (this instanceof HTMLInputElement &&
      ['text', 'search', 'email', 'url', 'tel', 'password', 'number'].includes(this.type));
  if (mode === 'probe') return ordinary;
  const emit = (inputType, data = null) => this.dispatchEvent(new InputEvent('input', {
    bubbles: true, composed: true, inputType, data
  }));
  if (mode === 'text') {
    if (!ordinary) return false;
    if (this.selectionStart === null) this.value += value;
    else this.setRangeText(value, this.selectionStart, this.selectionEnd, 'end');
    emit('insertText', value);
    return true;
  }
  if (mode !== 'key') return false;
  if (value === 'Enter') {
    if (this instanceof HTMLInputElement && this.form) {
      this.form.requestSubmit();
      return true;
    }
    if (this instanceof HTMLButtonElement || this instanceof HTMLAnchorElement) {
      this.click();
      return true;
    }
    return false;
  }
  if (value === 'Tab') {
    const items = [...doc.querySelectorAll('input,textarea,button,select,a[href],[tabindex]')]
      .filter(e => !e.disabled && e.tabIndex >= 0 && e.getClientRects().length);
    const next = items[(items.indexOf(this) + 1) % items.length];
    if (!next) return false;
    next.focus();
    return true;
  }
  if (!ordinary) return false;
  if (this.selectionStart === null) {
    if (value === 'Backspace') {
      this.value = this.value.slice(0, -1);
      emit('deleteContentBackward');
    }
    return true;
  }
  let a = this.selectionStart, b = this.selectionEnd;
  if (value === 'Backspace' || value === 'Delete') {
    if (a === b) {
      if (value === 'Backspace') a = Math.max(0, a - 1);
      else b = Math.min(this.value.length, b + 1);
    }
    this.setRangeText('', a, b, 'end');
    emit(value === 'Backspace' ? 'deleteContentBackward' : 'deleteContentForward');
  } else {
    const p = value === 'Home' ? 0 : value === 'End' ? this.value.length :
      value === 'ArrowLeft' ? Math.max(0, a - 1) : Math.min(this.value.length, b + 1);
    this.setSelectionRange(p, p);
  }
  return true;
}
