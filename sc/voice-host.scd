// The voice host behind `field keys <instrument>` (keyboard-instrument.md
// §2.6). It boots its own scsynth on the output device, loads the
// instrument's voice, and plays it from every MIDI source. Field reads
// only the lines that start with "@field ", each one JSON object; the rest
// of sclang's output is left for diagnosing a failure.
//
// Environment: FIELD_INSTRUMENT (the program's absolute path),
// FIELD_SC_PORT (the scsynth port Field chose), FIELD_PARENT_PID,
// FIELD_DEVICE (optional output device), FIELD_MODE=voice, and
// FIELD_VOICE_TRACE (optional: report each voice as it starts and ends).
(
var instrument = "FIELD_INSTRUMENT".getenv;
var port = "FIELD_SC_PORT".getenv.asInteger;
var parentPid = "FIELD_PARENT_PID".getenv;
var device = "FIELD_DEVICE".getenv;
var trace = "FIELD_VOICE_TRACE".getenv.notNil;
var server, voiceDef, loadError, voices, sustained, sustainDown = false, bend = 0, restarting = false;
var jsonValue, emit, fail, stopServer, deviceProblem, run, boot, startVoice, releaseVoice, releaseAll, restart;

jsonValue = { |value|
	if (value.isString or: { value.isKindOf(Symbol) }) {
		"\"" ++ value.asString.replace("\\", "\\\\").replace("\"", "\\\"") ++ "\""
	} { value.asString }
};
emit = { |pairs|
	var body = pairs.clump(2).collect { |kv| jsonValue.(kv[0]) ++ ":" ++ jsonValue.(kv[1]) }.join(",");
	("@field {" ++ body ++ "}").postln;
};
// A server that is still booting has not bound its port, so a /quit would
// miss it: the host stops its server by process.
stopServer = {
	server !? { |s| s.pid !? { |pid| ("kill " ++ pid ++ " 2>/dev/null").systemCmd } };
};
// exit does not stop the code that called it, so a failure is the last
// thing its branch does.
fail = { |message|
	emit.(["error", message]);
	stopServer.();
	1.exit;
};
// scsynth falls back to the default input and output for a name it does
// not find, which opens the microphone (§10.1), and SuperCollider passes
// the name to the shell that starts scsynth between bare double quotes.
deviceProblem = { |name|
	case
	{ name.any { |char| "\"`$\\".includes(char) } } {
		"the device name " ++ name ++ " has a character (\" ` $ \\) that would reach the shell that starts scsynth"
	}
	{ ServerOptions.outDevices.includesEqual(name).not } {
		"no output device named " ++ name ++ " (field devices lists them)"
	}
	{ nil };
};

startVoice = { |key, note, velocity|
	voices[key] !? { |old| old.set(\gate, 0) };
	sustained.remove(key);
	voices[key] = Synth(voiceDef.name, [\freq, (note + bend).midicps, \amp, velocity / 127, \gate, 1, \out, 0], server);
	if (trace) { emit.(["voice_on", note]) };
};
releaseVoice = { |key|
	voices.removeAt(key) !? { |synth|
		synth.set(\gate, 0);
		if (trace) { emit.(["voice_off", key % 128]) };
	};
};
releaseAll = {
	voices.keys.copy.do(releaseVoice);
	sustained.clear;
};

// Watched here rather than through waitForBoot, whose onFailure never runs
// in SuperCollider 3.14: a server that exits while it boots, as one does
// when the device will not start, would otherwise leave the host waiting
// forever. Each server's process is reported, so `field keys` can stop it
// even while it boots.
boot = {
	var started = Main.elapsedTime, launched;
	server.boot;
	Routine {
		var waiting = true;
		while { waiting } {
			0.1.wait;
			if (launched.isNil and: { server.pid.notNil }) {
				launched = server.pid;
				emit.(["server_pid", launched]);
			};
			case
			{ server.serverRunning } {
				waiting = false;
				voiceDef.add;
				server.sync;
				restarting = false;
				emit.(["ready", true, "device", device ? "system output", "sample_rate", server.sampleRate.asInteger]);
			}
			{ launched.notNil and: { server.pid.isNil } } {
				waiting = false;
				fail.("scsynth exited while it booted on " ++ (device ? "the system output") ++ ": the device did not start");
			}
			{ Main.elapsedTime - started > 20 } {
				waiting = false;
				fail.("scsynth did not boot on " ++ (device ? "the system output") ++ " within 20 seconds");
			};
		};
	}.play(AppClock);
};

// scsynth keeps computing at the rate it booted at when the device moves
// to another, so every voice would play sharp or flat. Each status reply
// carries the booted rate and the rate measured from the device clock.
restart = {
	restarting = true;
	voices.clear;
	sustained.clear;
	emit.(["restarting", true]);
	server.quit(onComplete: boot);
};

run = {
	server = Server(\fieldKeys, NetAddr("127.0.0.1", port));
	server.options.numInputBusChannels = 0;
	server.options.numOutputBusChannels = 2;
	server.options.hardwareBufferSize = 128;
	server.options.sampleRate = nil;
	// Named for both directions: given no input device, scsynth on macOS
	// opens the default one even with no input channels, and blocks on the
	// microphone permission (keyboard-instrument.md §10.1).
	if (device.notNil) {
		server.options.inDevice = device;
		server.options.outDevice = device;
	};
	Server.default = server;

	voices = Dictionary.new;
	sustained = Set.new;

	MIDIClient.init(verbose: false);
	MIDIIn.connectAll(verbose: false);

	MIDIdef.noteOn(\fieldNoteOn, { |velocity, note, chan|
		var key = chan * 128 + note;
		if (velocity == 0) {
			if (sustainDown) { sustained.add(key) } { releaseVoice.(key) };
		} {
			if (restarting.not) { startVoice.(key, note, velocity) };
		};
	});
	MIDIdef.noteOff(\fieldNoteOff, { |velocity, note, chan|
		var key = chan * 128 + note;
		if (sustainDown) { sustained.add(key) } { releaseVoice.(key) };
	});
	MIDIdef.cc(\fieldSustain, { |value|
		if (value >= 64) { sustainDown = true } {
			sustainDown = false;
			sustained.copy.do(releaseVoice);
			sustained.clear;
		};
	}, 64);
	MIDIdef.cc(\fieldAllNotesOff, { releaseAll.() }, 123);
	MIDIdef.bend(\fieldBend, { |value|
		bend = (value - 8192) / 8192 * 2;
		voices.keysValuesDo { |key, synth| synth.set(\freq, ((key % 128) + bend).midicps) };
	});

	Routine {
		loop {
			0.7.wait;
			if (restarting.not and: { server.serverRunning }) {
				var booted = server.sampleRate, measured = server.actualSampleRate;
				if (booted.notNil and: { measured.notNil } and: { booted > 0 } and: { (measured / booted - 1).abs > 0.01 }) {
					restart.();
				};
			};
		};
	}.play(AppClock);

	// No orphans: once `field keys` is gone, so is this host and its server.
	Routine {
		loop {
			1.wait;
			if (("kill -0 " ++ parentPid ++ " 2>/dev/null").systemCmd != 0) {
				stopServer.();
				0.exit;
			};
		};
	}.play(AppClock);

	boot.();
};

voiceDef = try { thisProcess.interpreter.executeFile(instrument) } { |error| loadError = error.errorString; nil };
case
	{ loadError.notNil } {
		fail.(PathName(instrument).fileName ++ " does not answer FIELD_MODE=voice: running it in voice mode failed with " ++ loadError);
	}
	{ voiceDef.isKindOf(SynthDef).not } {
		fail.(PathName(instrument).fileName ++ " does not answer FIELD_MODE=voice: in voice mode its value must be a SynthDef");
	}
	{ device.notNil and: { deviceProblem.(device).notNil } } { fail.(deviceProblem.(device)) }
	{ run.() };
)
