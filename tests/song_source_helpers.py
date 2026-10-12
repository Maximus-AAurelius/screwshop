"""Shared browser actions for the central SONGS sound source."""


def song_row(page, name):
    return page.locator('.ss-library-row').filter(has=page.locator(f'[data-name][value="{name}"]')).first


def menu_action(page, row, action):
    """Open a SONGS row's ⋮ menu and choose one action by its id (for example 'sampler-pad')."""
    row.locator('[data-row-menu]').click()
    page.locator(f'.im-menu [data-action="{action}"]').click()


def upload_song(page, audio, name):
    page.get_by_role('button', name='SONGS', exact=True).click()
    with page.expect_file_chooser() as chooser:
        page.get_by_role('button', name='+ UPLOAD FILE', exact=True).click()
    chooser.value.set_files(str(audio))
    row = song_row(page, name)
    row.wait_for(timeout=15000)
    return row


def load_song_pad(page, name, index):
    page.get_by_role('button', name='SONGS', exact=True).click()
    row = song_row(page, name)
    menu_action(page, row, 'sampler-pad')
    page.locator('[data-song-pad]').select_option(str(index))
    page.locator('[data-confirm-pad]').click()
    page.locator('#ss-sampler .ox-body').wait_for()
    page.wait_for_function('([name,index])=>sampler.slots[index]?.name===name', arg=[name, index])


def open_song_chop(page, name):
    page.get_by_role('button', name='SONGS', exact=True).click()
    row = song_row(page, name)
    menu_action(page, row, 'chop')
    page.locator('#sp-clip').wait_for()


def drop_song_on_key(page, name, selector):
    """Use the actual SONGS drag payload and the sampler key drop handler."""
    page.get_by_role('button', name='SONGS', exact=True).click()
    payload = song_row(page, name).evaluate('''el=>{
        const transfer=new DataTransfer();
        el.dispatchEvent(new DragEvent('dragstart',{bubbles:true,dataTransfer:transfer}));
        const payload=transfer.getData('application/x-screwshop-loop');
        el.dispatchEvent(new DragEvent('dragend',{bubbles:true,dataTransfer:transfer}));
        return payload;
    }''')
    assert payload, 'SONGS row must provide an audio drag payload'
    page.get_by_role('button', name='M-AUDIO / SAMPLER', exact=True).first.click()
    page.locator(selector).evaluate('''(el,payload)=>{
        const transfer=new DataTransfer();transfer.setData('application/x-screwshop-loop',payload);
        el.dispatchEvent(new DragEvent('drop',{bubbles:true,dataTransfer:transfer}));
    }''', payload)
