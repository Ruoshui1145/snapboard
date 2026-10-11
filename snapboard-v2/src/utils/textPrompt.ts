/** Browser and Electron compatible name dialog. Native window.prompt is unavailable in Electron. */
export function textPrompt(message: string, initialValue = ''): Promise<string | null> {
  return new Promise(resolve => {
    const previousFocus = document.activeElement as HTMLElement | null;
    const dialog = document.createElement('dialog');
    dialog.setAttribute('aria-label', message);
    dialog.style.cssText = 'width:min(420px,85vw);padding:24px;border:1px solid #365568;border-radius:16px;background:#121b2b;color:#ecf3fa;box-shadow:0 18px 70px #0009;font:16px system-ui;';
    const form = document.createElement('form'); form.method='dialog';
    const label = document.createElement('label'); label.textContent=message;
    const input = document.createElement('input'); input.value=initialValue; input.type='text'; input.maxLength=80;
    input.setAttribute('aria-label',message);
    input.style.cssText='display:block;box-sizing:border-box;width:100%;margin:16px 0 20px;padding:12px;border:1px solid #527985;border-radius:8px;background:#1c283c;color:#fff;font:inherit;';
    label.append(input);
    const actions = document.createElement('div');actions.style.cssText='display:flex;justify-content:flex-end;gap:12px';
    const cancel = document.createElement('button');cancel.type='button';cancel.textContent='取消';
    const confirm = document.createElement('button');confirm.type='submit';confirm.textContent='确定';
    for(const button of [cancel,confirm]) button.style.cssText='padding:9px 20px;border:1px solid #527985;border-radius:8px;cursor:pointer;background:#203044;color:#fff;font:inherit';
    confirm.style.background='#157c79';
    let settled=false;
    const finish=(value:string|null)=>{if(settled)return;settled=true;dialog.close();dialog.remove();previousFocus?.focus();resolve(value);};
    form.addEventListener('submit',event=>{event.preventDefault();finish(input.value);});
    cancel.addEventListener('click',()=>finish(null));
    dialog.addEventListener('cancel',event=>{event.preventDefault();finish(null);});
    actions.append(cancel,confirm);form.append(label,actions);dialog.append(form);document.body.append(dialog);
    dialog.showModal();input.focus();input.select();
  });
}
