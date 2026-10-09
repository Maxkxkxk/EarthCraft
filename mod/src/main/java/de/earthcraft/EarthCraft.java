package de.earthcraft;

import com.google.gson.JsonObject;
import com.mojang.brigadier.arguments.DoubleArgumentType;
import com.mojang.brigadier.arguments.StringArgumentType;
import net.fabricmc.api.ModInitializer;
import net.fabricmc.fabric.api.command.v2.CommandRegistrationCallback;
import net.fabricmc.fabric.api.event.lifecycle.v1.ServerLifecycleEvents;
import net.fabricmc.fabric.api.event.lifecycle.v1.ServerTickEvents;
import net.fabricmc.fabric.api.event.lifecycle.v1.ServerWorldEvents;
import net.fabricmc.fabric.api.networking.v1.PayloadTypeRegistry;
import net.fabricmc.fabric.api.networking.v1.ServerPlayConnectionEvents;
import net.fabricmc.fabric.api.networking.v1.ServerPlayNetworking;
import net.minecraft.ChatFormatting;
import net.minecraft.commands.CommandSourceStack;
import net.minecraft.commands.Commands;
import net.minecraft.core.Registry;
import net.minecraft.core.registries.BuiltInRegistries;
import net.minecraft.network.chat.Component;
import net.minecraft.resources.ResourceLocation;
import net.minecraft.server.MinecraftServer;
import net.minecraft.server.level.ServerLevel;
import net.minecraft.server.level.ServerPlayer;
import net.minecraft.world.level.Level;
import net.minecraft.world.level.levelgen.Heightmap;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import java.net.URLEncoder;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.util.HashMap;
import java.util.Locale;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.CompletableFuture;

public class EarthCraft implements ModInitializer {
	public static final String MOD_ID = "earthcraft";
	public static final Logger LOGGER = LoggerFactory.getLogger(MOD_ID);

	/** Region list version each player has received. */
	private static final Map<UUID, Integer> syncedVersion = new HashMap<>();

	public static ResourceLocation id(String path) {
		return ResourceLocation.fromNamespaceAndPath(MOD_ID, path);
	}

	@Override
	public void onInitialize() {
		EarthConfig.get();
		EarthBlocks.init();
		Registry.register(BuiltInRegistries.CHUNK_GENERATOR, id("earth"), EarthChunkGenerator.CODEC);
		PayloadTypeRegistry.playS2C().register(RegionsPayload.TYPE, RegionsPayload.CODEC);

		// Start the tile service early (if configured) so it is up when a world loads.
		Thread starter = new Thread(ServiceClient::ensureRunning, "EarthCraft service starter");
		starter.setDaemon(true);
		starter.start();

		ServerWorldEvents.LOAD.register((server, level) -> {
			if (level.dimension() == Level.OVERWORLD && level.getChunkSource().getGenerator() instanceof EarthChunkGenerator gen) {
				EarthRegions.load(server, gen);
			}
		});
		ServerLifecycleEvents.SERVER_STOPPED.register(server -> EarthRegions.unload());
		ServerPlayConnectionEvents.DISCONNECT.register((handler, server) -> syncedVersion.remove(handler.player.getUUID()));
		ServerTickEvents.END_SERVER_TICK.register(EarthCraft::syncRegions);

		CommandRegistrationCallback.EVENT.register((dispatcher, registryAccess, environment) -> dispatcher.register(
			Commands.literal("earth")
				.then(Commands.literal("goto")
					.then(Commands.argument("ort", StringArgumentType.greedyString())
						.executes(ctx -> goTo(ctx.getSource(), StringArgumentType.getString(ctx, "ort")))))
				.then(Commands.literal("where").executes(ctx -> where(ctx.getSource())))
				.then(Commands.literal("setlocation").requires(src -> src.hasPermission(2))
					.then(Commands.argument("latitude", DoubleArgumentType.doubleArg(-90, 90))
						.then(Commands.argument("longitude", DoubleArgumentType.doubleArg(-180, 180)).executes(ctx -> {
							EarthConfig cfg = EarthConfig.get();
							cfg.latitude = DoubleArgumentType.getDouble(ctx, "latitude");
							cfg.longitude = DoubleArgumentType.getDouble(ctx, "longitude");
							cfg.save();
							ctx.getSource().sendSuccess(() -> Component.literal(String.format(Locale.ROOT,
								"Neue EarthCraft-Welten starten jetzt bei %.6f, %.6f. Innerhalb einer Welt geht es schneller mit /earth goto.", cfg.latitude, cfg.longitude)), false);
							return 1;
						}))))));
		LOGGER.info("EarthCraft initialized");
	}

	public static EarthChunkGenerator generator(MinecraftServer server) {
		return server.overworld().getChunkSource().getGenerator() instanceof EarthChunkGenerator g ? g : null;
	}

	private static int where(CommandSourceStack src) {
		EarthChunkGenerator gen = generator(src.getServer());
		var p = src.getPosition();
		EarthRegions.Region r = gen == null ? null : gen.regionFor(p.x, p.z);
		if (r == null || Double.isNaN(r.groundHeight())) {
			src.sendFailure(Component.literal("Hier ist kein EarthCraft-Ort."));
			return 0;
		}
		double[] g = Geo.mcToGeodetic(r.latitude(), r.longitude(), r.groundHeight(), p.x - r.offsetX(), p.y, p.z - r.offsetZ());
		String link = String.format(Locale.ROOT, "https://www.google.com/maps/@%.6f,%.6f,19z", g[0], g[1]);
		src.sendSuccess(() -> Component.literal(String.format(Locale.ROOT, "Du bist bei %.6f, %.6f  ", g[0], g[1]))
			.append(Component.literal(link).withStyle(s -> s.withColor(ChatFormatting.AQUA).withUnderlined(true)
				.withClickEvent(new net.minecraft.network.chat.ClickEvent(net.minecraft.network.chat.ClickEvent.Action.OPEN_URL, link)))), false);
		return 1;
	}

	/** /earth goto <address | lat, lon>: finds the place, creates a region for it if needed and teleports there. */
	private static int goTo(CommandSourceStack src, String query) {
		ServerPlayer player = src.getPlayer(); // null from the console: only creates the place and reports it
		MinecraftServer server = src.getServer();
		if (generator(server) == null) {
			src.sendFailure(Component.literal("Das ist keine EarthCraft-Welt (Welttyp „EarthCraft (Google 3D)“)."));
			return 0;
		}
		src.sendSuccess(() -> Component.literal("Suche „" + query + "“ …").withStyle(ChatFormatting.GRAY), false);
		CompletableFuture.runAsync(() -> {
			try {
				JsonObject geo = ServiceClient.getJson("/geocode?q=" + URLEncoder.encode(query, StandardCharsets.UTF_8), Duration.ofSeconds(20));
				double lat = geo.get("lat").getAsDouble(), lon = geo.get("lon").getAsDouble();
				String address = geo.get("address").getAsString();

				// Reuse a nearby region, otherwise make a new one centered on the target.
				EarthRegions.Region region = null;
				double[] local = null;
				for (EarthRegions.Region r : EarthRegions.all()) {
					if (Double.isNaN(r.groundHeight())) continue;
					double[] l = Geo.geodeticToMc(r.latitude(), r.longitude(), r.groundHeight(), lat, lon, r.groundHeight());
					if (Math.hypot(l[0], l[2]) < EarthRegions.REUSE_RADIUS && (local == null || Math.hypot(l[0], l[2]) < Math.hypot(local[0], local[2]))) {
						region = r;
						local = l;
					}
				}
				EarthRegions.Region existing = region;
				double ground = Double.NaN;
				if (existing == null) {
					message(server, src, Component.literal("Neuer Ort: " + address + " – lade 3D-Daten …").withStyle(ChatFormatting.GRAY));
					ground = ServiceClient.getJson(String.format(Locale.ROOT, "/ground?lat=%.8f&lon=%.8f", lat, lon), Duration.ofSeconds(90)).get("height").getAsDouble();
					local = new double[] {0, EarthChunkGenerator.GROUND_Y, 0};
				}
				double newGround = ground;
				double[] target = local;
				server.execute(() -> {
					EarthRegions.Region r = existing != null ? existing : EarthRegions.add(lat, lon, newGround);
					ServerLevel level = server.overworld();
					int x = (int) Math.floor(r.offsetX() + target[0]), z = (int) Math.floor(r.offsetZ() + target[2]);
					level.getChunk(x >> 4, z >> 4); // generate before reading the height
					int y = level.getHeight(Heightmap.Types.MOTION_BLOCKING, x, z);
					LOGGER.info("goto {} ({}, {}) -> region {} at {} {} {}", address, lat, lon, r.index(), x, y, z);
					if (player == null) {
						src.sendSuccess(() -> Component.literal(String.format(Locale.ROOT, "%s: Ort %d bei %d %d %d", address, r.index(), x, y, z)), false);
						return;
					}
					if (player.isRemoved()) return;
					player.teleportTo(level, x + 0.5, y, z + 0.5, player.getYRot(), player.getXRot());
					player.sendSystemMessage(Component.literal("Willkommen: " + address).withStyle(ChatFormatting.GREEN));
				});
			} catch (Exception e) {
				message(server, src, Component.literal("Ort nicht erreichbar: " + e.getMessage()).withStyle(ChatFormatting.RED));
			}
		});
		return 1;
	}

	private static void message(MinecraftServer server, CommandSourceStack src, Component text) {
		server.execute(() -> src.sendSystemMessage(text));
	}

	private static void syncRegions(MinecraftServer server) {
		if (server.getTickCount() % 10 != 0 || generator(server) == null) return;
		var regions = EarthRegions.all();
		if (regions.isEmpty() || Double.isNaN(regions.get(0).groundHeight())) return;
		int version = EarthRegions.version;
		for (ServerPlayer player : server.getPlayerList().getPlayers()) {
			Integer seen = syncedVersion.get(player.getUUID());
			if (seen == null || seen != version) {
				syncedVersion.put(player.getUUID(), version);
				ServerPlayNetworking.send(player, new RegionsPayload(regions));
			}
		}
	}
}
