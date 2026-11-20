import Testing

func expectEqual<T: Equatable>(
  _ actual: @autoclosure () throws -> T, _ expected: @autoclosure () throws -> T,
  sourceLocation: SourceLocation = #_sourceLocation
) {
  do {
    let a = try actual()
    let e = try expected()
    #expect(a == e, sourceLocation: sourceLocation)
  } catch { Issue.record(error, sourceLocation: sourceLocation) }
}
func expectNil<T>(
  _ actual: @autoclosure () throws -> T?, sourceLocation: SourceLocation = #_sourceLocation
) {
  do {
    let a = try actual()
    #expect(a == nil, sourceLocation: sourceLocation)
  } catch { Issue.record(error, sourceLocation: sourceLocation) }
}
func expectNotNil<T>(
  _ actual: @autoclosure () throws -> T?, sourceLocation: SourceLocation = #_sourceLocation
) {
  do {
    let a = try actual()
    #expect(a != nil, sourceLocation: sourceLocation)
  } catch { Issue.record(error, sourceLocation: sourceLocation) }
}
func expectThrows<T>(
  _ action: @autoclosure () throws -> T, sourceLocation: SourceLocation = #_sourceLocation
) {
  do {
    _ = try action()
    Issue.record("Expected rejection", sourceLocation: sourceLocation)
  } catch {}
}
