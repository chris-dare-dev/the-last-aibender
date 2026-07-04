//! Menu-bar tray — a native affordance (blueprint §2). The icon is a
//! runtime-generated template image (no binary asset enters the tree): the
//! RGBA square is rendered as a macOS TEMPLATE image, so the system draws it
//! monochrome per menu-bar appearance — instrument discipline, no brand
//! sparkle. (Pixel value mirrors --ig-accent #FFB000 for non-template
//! fallbacks; DESIGN.md §2.3 — mirrored, not invented.)

use tauri::{
    image::Image,
    menu::{Menu, MenuItem},
    tray::TrayIconBuilder,
    App, Manager,
};

fn accent_template_icon() -> Image<'static> {
    const SIZE: usize = 16;
    let mut rgba = vec![0u8; SIZE * SIZE * 4];
    for (i, px) in rgba.chunks_exact_mut(4).enumerate() {
        let x = i % SIZE;
        let y = i / SIZE;
        // Hollow square, 2px stroke — reads as an instrument tick at 16px.
        let edge = x < 2 || y < 2 || x >= SIZE - 2 || y >= SIZE - 2;
        px[0] = 0xFF;
        px[1] = 0xB0;
        px[2] = 0x00;
        px[3] = if edge { 0xFF } else { 0x00 };
    }
    Image::new_owned(rgba, SIZE as u32, SIZE as u32)
}

pub fn install(app: &mut App) -> tauri::Result<()> {
    let show = MenuItem::with_id(app, "show", "Show Cockpit", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&show, &quit])?;

    TrayIconBuilder::with_id("aibender-tray")
        .icon(accent_template_icon())
        .icon_as_template(true)
        .menu(&menu)
        .show_menu_on_left_click(true)
        .on_menu_event(|app, event| match event.id().as_ref() {
            "show" => {
                if let Some(window) = app.get_webview_window("main") {
                    let _ = window.show();
                    let _ = window.set_focus();
                }
            }
            "quit" => app.exit(0),
            _ => {}
        })
        .build(app)?;
    Ok(())
}
