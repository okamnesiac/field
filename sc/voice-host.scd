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
// sclang's own port, which Field also chooses (-u), takes /field/reload:
// load the program again, as its file has changed (§14).
(
var here = PathName(thisProcess.nowExecutingPath).pathOnly;
var loadVoice = thisProcess.interpreter.executeFile(here +/+ "voice-load.scd");
var instrument = "FIELD_INSTRUMENT".getenv;
var port = "FIELD_SC_PORT".getenv.asInteger;
var parentPid = "FIELD_PARENT_PID".getenv;
var device = "FIELD_DEVICE".getenv;
var trace = "FIELD_VOICE_TRACE".getenv.notNil;
// True until the server answers, at the first boot and at each restart:
// a note then has no server to sound on, so it is ignored.
var server, voiceDef, problem, voicer, booting = true;
var jsonValue, emit, fail, stopServer, deviceProblem, run, boot, restart;

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
				booting = false;
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
	booting = true;
	voicer.forgetVoices;
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

	voicer = thisProcess.interpreter.executeFile(here +/+ "voicer.scd").(
		{ |note, velocity, freq, mod|
			Synth(voiceDef.name, [\freq, freq, \amp, velocity / 127, \gate, 1, \out, 0, \mod, mod], server)
		},
		{ |synth, control, value| synth.set(control, value) },
		{ |synth| synth.set(\gate, 0) },
		if (trace) { { |note, on| emit.([if (on) { "voice_on" } { "voice_off" }, note]) } }
	);

	MIDIClient.init(verbose: false);
	MIDIIn.connectAll(verbose: false);

	MIDIdef.noteOn(\fieldNoteOn, { |velocity, note, chan|
		if (booting.not) { voicer.noteOn(chan, note, velocity) };
	});
	MIDIdef.noteOff(\fieldNoteOff, { |velocity, note, chan| voicer.noteOff(chan, note) });
	MIDIdef.cc(\fieldControl, { |value, number, chan| voicer.cc(chan, number, value) });
	MIDIdef.bend(\fieldBend, { |value, chan| voicer.bend(chan, value) });

	// The program's file changed: load it again. A voice that loads is
	// what the next note plays, and the notes sounding finish as they
	// started; one that does not leaves the last good voice playing.
	OSCdef(\fieldReload, { |msg, time, addr|
		if (addr.ip == "127.0.0.1") {
			var next, why;
			# next, why = loadVoice.(instrument);
			case
			{ why.notNil } { emit.(["reload_error", why]) }
			{ booting } {
				// The boot adds whatever voiceDef holds when the server answers.
				voiceDef = next;
				emit.(["reloaded", true]);
			}
			{
				voiceDef = next;
				fork {
					voiceDef.add;
					server.sync;
					emit.(["reloaded", true]);
				};
			};
		};
	}, '/field/reload');

	Routine {
		loop {
			0.7.wait;
			if (booting.not and: { server.serverRunning }) {
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

# voiceDef, problem = loadVoice.(instrument);
case
	{ problem.notNil } { fail.(problem) }
	{ device.notNil and: { deviceProblem.(device).notNil } } { fail.(deviceProblem.(device)) }
	{ run.() };
)
