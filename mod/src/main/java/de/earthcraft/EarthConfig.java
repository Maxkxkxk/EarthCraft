package de.earthcraft;

import com.google.gson.Gson;
import com.google.gson.GsonBuilder;
import net.fabricmc.loader.api.FabricLoader;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;

/** config/earthcraft.json */
public class EarthConfig {
	private static final Gson GSON = new GsonBuilder().setPrettyPrinting().create();
	private static EarthConfig instance;

	/** Where the EarthCraft tile service listens. */
	public String serviceUrl = "http://127.0.0.1:8765";
	/** If set, the mod starts the service itself ("node src/server.mjs" in this folder). */
	public String serviceDir = "";
	public String nodeExecutable = "node";

	/** Location used for NEW EarthCraft worlds. Existing worlds keep the location they were created with. */
	public double latitude = 52.516275;
	public double longitude = 13.377704;

	/** Render distance of the 3D map in blocks (Minecraft's own far plane is raised to this). */
	public int mapRenderDistance = 3000;

	public static EarthConfig get() {
		if (instance == null) instance = load();
		return instance;
	}

	public static Path path() {
		return FabricLoader.getInstance().getConfigDir().resolve("earthcraft.json");
	}

	private static EarthConfig load() {
		Path p = path();
		EarthConfig cfg = new EarthConfig();
		try {
			if (Files.exists(p)) cfg = GSON.fromJson(Files.readString(p, StandardCharsets.UTF_8), EarthConfig.class);
		} catch (Exception e) {
			EarthCraft.LOGGER.error("Could not read {}, using defaults", p, e);
		}
		cfg.save();
		return cfg;
	}

	public void save() {
		try {
			Files.writeString(path(), GSON.toJson(this), StandardCharsets.UTF_8);
		} catch (IOException e) {
			EarthCraft.LOGGER.error("Could not write {}", path(), e);
		}
	}
}
