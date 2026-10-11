// Loads an instrument program's voice (keyboard-instrument.md §2.6): for
// the live voice host, at start and on each reload (§14), and for the
// offline render of a take (§12.3). Its value is a function of the
// program's path and the path of the checked copy of its knob file, or
// nil when it has none, that answers [voiceDef, nil], or [nil, why] when
// the program does not compile, fails, or answers something other than a
// SynthDef. The caller's environment carries FIELD_MODE=voice; the program
// finds its knob file's copy in FIELD_KNOBS (instrument-knobs.md §2.4).
{ |path, knobs|
	var name = PathName(path).fileName, compiled, value, error, saved;
	compiled = thisProcess.interpreter.compileFile(path);
	if (compiled.isNil) {
		[nil, name ++ " does not compile"]
	} {
		if (knobs.notNil) { "FIELD_KNOBS".setenv(knobs) } { "FIELD_KNOBS".unsetenv };
		// As executeFile runs it, so a program can find its own directory.
		saved = thisProcess.nowExecutingPath;
		thisProcess.nowExecutingPath = path;
		value = protect { try { compiled.value } { |e| error = e.errorString; nil } } { thisProcess.nowExecutingPath = saved };
		case
		{ error.notNil } { [nil, name ++ " does not answer FIELD_MODE=voice: running it in voice mode failed with " ++ error] }
		{ value.isKindOf(SynthDef).not } { [nil, name ++ " does not answer FIELD_MODE=voice: in voice mode its value must be a SynthDef"] }
		{ [value, nil] }
	}
}
