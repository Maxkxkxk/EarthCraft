package de.earthcraft.client;

import de.earthcraft.RegionsPayload;
import net.fabricmc.api.ClientModInitializer;
import net.fabricmc.fabric.api.client.event.lifecycle.v1.ClientChunkEvents;
import net.fabricmc.fabric.api.client.event.lifecycle.v1.ClientTickEvents;
import net.fabricmc.fabric.api.client.networking.v1.ClientPlayConnectionEvents;
import net.fabricmc.fabric.api.client.networking.v1.ClientPlayNetworking;
import net.fabricmc.fabric.api.client.rendering.v1.HudRenderCallback;
import net.fabricmc.fabric.api.client.rendering.v1.WorldRenderEvents;
import net.minecraft.client.Minecraft;

public class EarthCraftClient implements ClientModInitializer {
	@Override
	public void onInitializeClient() {
		MapRenderer renderer = MapRenderer.INSTANCE;
		ClientPlayNetworking.registerGlobalReceiver(RegionsPayload.TYPE, (payload, context) -> context.client().execute(() -> renderer.setRegions(payload)));
		ClientPlayConnectionEvents.DISCONNECT.register((handler, client) -> client.execute(renderer::clear));
		ClientTickEvents.END_CLIENT_TICK.register(renderer::tick);
		ClientChunkEvents.CHUNK_LOAD.register((level, chunk) -> renderer.onChunkLoaded(chunk.getPos()));
		WorldRenderEvents.AFTER_ENTITIES.register(renderer::render);

		HudRenderCallback.EVENT.register((graphics, delta) -> {
			Minecraft mc = Minecraft.getInstance();
			if (!renderer.enabled()) return; // attribution stays visible even with F1 (Google requirement)
			var font = mc.font;
			int h = graphics.guiHeight();
			// Attribution required by the Google Map Tiles API terms.
			var parts = new java.util.ArrayList<>(renderer.attribution);
			if (!parts.contains("Google")) parts.add(0, "Google");
			String attr = String.join(", ", parts);
			graphics.drawString(font, attr, 4, h - 12, 0xFFFFFFFF, true);
			if (!renderer.status.isEmpty() && !mc.options.hideGui) graphics.drawString(font, renderer.status, 4, 4, 0xFFFF5555, true);
		});
	}
}
